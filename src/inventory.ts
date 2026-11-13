import { z } from "zod";
import { buildDeclarativeUsers, syncNaiveNode } from "./naive-sync";
import type {
  ClientOutcome,
  ClientSyncRequest,
  ConflictStrategy,
  DesiredClient,
} from "./3x-ui";
import { naiveLogin } from "./credentials";
import type { NodeRecord, Storage } from "./storage";

const httpUrl = z
  .url()
  .refine(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "Use HTTP or HTTPS",
  );
export const hostSchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  name: z.string().trim().min(1),
  url: httpUrl,
  secret: z.string().default(""),
});
export const serviceSchema = z
  .object({
    id: z.number().int().positive().nullable().default(null),
    hostId: z.number().int().positive(),
    name: z.string().trim().min(1),
    path: z
      .string()
      .regex(/^(\/[A-Za-z0-9_-]+)*$/)
      .default(""),
    type: z.enum(["xui", "naive", "shadowsocks", "mieru", "xray"]),
    inboundId: z.number().int().nonnegative().default(0),
  })
  .refine(
    (s) => s.type !== "xui" || s.inboundId > 0,
    "3x-ui requires an inbound ID",
  );
export const connectionSchema = z
  .object({
    id: z.number().int().positive().nullable().default(null),
    name: z.string().trim().min(1),
    template: z.string().trim().min(1),
    nodeId: z.number().int().positive().nullable().default(null),
  })
  .refine(
    (c) => !c.template.includes("{ip}") || c.nodeId !== null,
    "{ip} requires a managed service",
  );
const nodeTypeSchema = z.enum(["xui", "naive", "shadowsocks", "mieru", "xray"]);
/** What the admin UI edits: a link template plus, optionally, the agent backend it syncs users to. */
export const serverSchema = z
  .object({
    id: z.number().int().positive().nullable().default(null),
    name: z.string().trim().min(1),
    template: z.string().trim().min(1),
    target: z
      .object({
        hostId: z.number().int().positive(),
        type: nodeTypeSchema,
        path: z
          .string()
          .regex(/^(\/[A-Za-z0-9_-]+)*$/, "Path looks like /naive or is empty")
          .default(""),
        inboundId: z.number().int().nonnegative().default(0),
      })
      .refine(
        (t) => t.type !== "xui" || t.inboundId > 0,
        "3x-ui requires an inbound ID",
      )
      .nullable()
      .default(null),
    profiles: z.array(z.string()).optional(),
  })
  .refine(
    (s) => !s.template.includes("{ip}") || s.target !== null,
    "{ip} takes the address from a host; pick one or write the address",
  );

/**
 * Saves a connection and, when `profiles` is given, makes it exactly that set. Returns the
 * services whose user lists changed (previous one included when the server moved).
 */
export function saveConnectionWithProfiles(
  storage: Storage,
  owner: number,
  p: {
    id: number | null;
    name: string;
    template: string;
    nodeId: number | null;
    profiles?: string[];
  },
): { id: number; ids: Set<number> } {
  return storage.transaction(() => {
    const previous = storage
      .listConnections(owner)
      .find((c) => c.id === p.id);
    const previousProfiles = previous
      ? storage
          .listProfiles(owner)
          .filter((profile) =>
            storage
              .listServerRecords(profile.name, owner)
              .some((c) => c.connectionId === previous.id),
          )
      : [];
    const ids = new Set<number>();
    // Name or template edits don't change anyone's access, so they need no push.
    if (previous && previousProfiles.length && previous.nodeId !== p.nodeId) {
      if (previous.nodeId !== null) {
        ids.add(previous.nodeId);
        for (const profile of previousProfiles)
          for (const u of storage.listUsers(profile.name, owner))
            storage.queueRemoval(
              previous.nodeId,
              xuiEmail(profile.name, u.clientName),
              u.userUuid,
              owner,
            );
      }
      if (p.nodeId !== null) ids.add(p.nodeId);
    }
    const id = storage.saveConnection(
      p.id,
      p.name,
      p.template,
      p.nodeId,
      owner,
    );
    if (p.profiles) {
      for (const profile of p.profiles)
        if (!storage.getProfile(profile, owner))
          throw new Error("Unknown profile");
      const changed = applyAssignments(storage, owner, {
        assignments: storage.listProfiles(owner).map((profile) => ({
          connectionId: id,
          profile: profile.name,
          included: p.profiles!.includes(profile.name),
        })),
      });
      changed.ids.forEach((n) => ids.add(n));
    }
    return { id, ids };
  });
}

export function saveServer(
  storage: Storage,
  owner: number,
  p: z.infer<typeof serverSchema>,
): { id: number; ids: Set<number> } {
  return storage.transaction(() => {
    const nodeId = p.target
      ? storage.findOrCreateService(
          p.target.hostId,
          p.target.type,
          p.target.path,
          p.target.type === "xui" ? p.target.inboundId : 0,
          p.name,
          owner,
        )
      : null;
    return saveConnectionWithProfiles(storage, owner, { ...p, nodeId });
  });
}

export const assignmentsSchema = z.object({
  assignments: z
    .array(
      z.object({
        connectionId: z.number().int().positive(),
        profile: z.string().min(1),
        included: z.boolean(),
      }),
    )
    .max(10000),
});

export function inventory(storage: Storage, owner: number) {
  const profiles = storage.listProfiles(owner);
  return {
    hosts: storage.listHosts(owner),
    services: storage.listNodes(owner).map(({ secret, ...n }) => n),
    connections: storage.listConnections(owner),
    profiles,
    memberships: profiles.flatMap((p) =>
      storage.listServerRecords(p.name, owner).map((s) => ({
        profile: p.name,
        connectionId: s.connectionId!,
        name: s.name,
        displayName: s.displayName,
        sortOrder: s.sortOrder,
      })),
    ),
  };
}

export type InventorySyncResult = {
  nodeId: number;
  name: string;
  ok: boolean;
  error?: string;
  synced?: number;
  /** 3x-ui only: what happened (or, for a dry run, would happen) per client. */
  steps?: ClientOutcome[];
  dryRun?: boolean;
};
export type SyncOptions = { onConflict?: ConflictStrategy; dryRun?: boolean };

/**
 * 3x-ui emails are global per panel, so like the other protocols' logins they carry the
 * profile: the same client name in two profiles is two different people.
 */
export const xuiEmail = naiveLogin;

/** Everyone who should be on this 3x-ui service, across every profile using it. */
export function desiredXuiClients(
  storage: Storage,
  nodeId: number,
  owner: number,
): DesiredClient[] {
  return storage
    .listProfiles(owner)
    .filter((p) =>
      storage.listServerRecords(p.name, owner).some((s) => s.nodeId === nodeId),
    )
    .flatMap((p) =>
      storage.listUsers(p.name, owner).map((u) => ({
        email: xuiEmail(p.name, u.clientName),
        uuid: u.userUuid,
        // Pre-2.0 panels hold the plain name; the agent renames it in place.
        legacyEmail: u.clientName,
      })),
    );
}

/** One batch request to the agent; it reads the panel once and applies a UUID-based plan. */
export async function pushXuiClients(
  node: NodeRecord,
  body: Omit<ClientSyncRequest, "inboundId">,
): Promise<ClientOutcome[]> {
  const response = await fetch(`${node.url}/sync-clients`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${node.secret}`,
    },
    body: JSON.stringify({ inboundId: node.inboundId, ...body }),
    signal: AbortSignal.timeout(120000),
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  if (response.status === 404)
    throw new Error(
      "This host's lsmnode is too old for 3x-ui sync. Update lsmnode on it (2.0+), then push again.",
    );
  const data = (await response.json()) as {
    results?: ClientOutcome[];
    error?: string;
  };
  if (!response.ok || !Array.isArray(data.results))
    throw new Error(data.error ?? `Agent returned ${response.status}`);
  return data.results;
}

const PRESENT = new Set(["unchanged", "add", "rename", "attach", "overwrite", "keep-both"]);

async function syncXui(
  storage: Storage,
  owner: number,
  node: NodeRecord,
  { onConflict = "skip", dryRun = false }: SyncOptions,
): Promise<InventorySyncResult> {
  const clients = desiredXuiClients(storage, node.id, owner);
  const wanted = new Set(clients.map((c) => c.uuid));
  const pending = storage.pendingRemovals(node.id, owner);
  const steps = await pushXuiClients(node, {
    clients,
    // A revoked UUID that is still wanted on this service (another profile) stays.
    remove: pending
      .filter((r) => !wanted.has(r.userUuid))
      .map((r) => ({ email: r.clientName, uuid: r.userUuid })),
    onConflict,
    dryRun,
  });
  const failed = steps.filter((s) => !s.ok);
  if (!dryRun) {
    const retry = new Set(failed.map((s) => s.uuid));
    storage.clearRemovals(
      node.id,
      owner,
      pending.filter((r) => !retry.has(r.userUuid)).map((r) => r.userUuid),
    );
  }
  return {
    nodeId: node.id,
    name: node.name,
    ok: failed.length === 0,
    error: failed.length
      ? `${failed.length} change(s) failed, e.g. ${failed[0]!.email}: ${failed[0]!.error}`
      : undefined,
    synced: steps.filter((s) => s.ok && PRESENT.has(s.kind)).length,
    steps,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

const queues = new Map<number, Promise<unknown>>();
/** Serialize full-list pushes so a stale request can never finish after a newer assignment. */
export async function syncInventory(
  storage: Storage,
  owner: number,
  ids: number[],
  removed: Map<
    number,
    { profileName: string; clientName: string; userUuid: string }[]
  > = new Map(),
  options: SyncOptions = {},
): Promise<InventorySyncResult[]> {
  for (const [id, users] of removed)
    if (storage.getNode(id, owner)?.type === "xui")
      for (const u of users)
        storage.queueRemoval(
          id,
          xuiEmail(u.profileName, u.clientName),
          u.userUuid,
          owner,
        );
  return Promise.all(
    [...new Set(ids)].map(async (id) => {
      const key = id;
      const work = (queues.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async (): Promise<InventorySyncResult> => {
          const node = storage.getNode(id, owner);
          if (!node)
            return {
              nodeId: id,
              name: String(id),
              ok: false,
              error: "Service no longer exists",
            };
          try {
            if (node.type === "xui")
              return await syncXui(storage, owner, node, options);
            const list = buildDeclarativeUsers(storage, node, owner);
            // Declarative backends take the whole list; there is nothing to preview per user.
            if (options.dryRun)
              return {
                nodeId: id,
                name: node.name,
                ok: true,
                synced: list.users.length,
                dryRun: true,
              };
            const result = await syncNaiveNode(node, list.users);
            if (result.error || list.skipped.length)
              throw new Error(
                result.error ??
                  `Skipped invalid users: ${list.skipped.join(", ")}`,
              );
            storage.clearRemovals(id, owner);
            return {
              nodeId: id,
              name: node.name,
              ok: true,
              synced: result.synced,
            };
          } catch (e) {
            return {
              nodeId: id,
              name: node.name,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        });
      queues.set(key, work);
      try {
        return await work;
      } finally {
        if (queues.get(key) === work) queues.delete(key);
      }
    }),
  );
}

export function applyAssignments(
  storage: Storage,
  owner: number,
  body: z.infer<typeof assignmentsSchema>,
) {
  const ids = new Set<number>();
  const removed = new Map<
    number,
    { profileName: string; clientName: string; userUuid: string }[]
  >();
  storage.transaction(() => {
    for (const a of body.assignments) {
      const connection = storage
        .listConnections(owner)
        .find((c) => c.id === a.connectionId);
      if (!connection) throw new Error("Unknown connection");
      if (!storage.getProfile(a.profile, owner))
        throw new Error("Unknown profile");
      const wasIncluded = storage
        .listServerRecords(a.profile, owner)
        .some((c) => c.connectionId === a.connectionId);
      if (connection.nodeId !== null && a.included !== wasIncluded) {
        ids.add(connection.nodeId);
        if (!a.included)
          removed.set(connection.nodeId, [
            ...(removed.get(connection.nodeId) ?? []),
            ...storage.listUsers(a.profile, owner),
          ]);
      }
      if (
        !a.included &&
        wasIncluded &&
        connection.nodeId !== null &&
        storage.getNode(connection.nodeId, owner)?.type === "xui"
      )
        for (const u of storage.listUsers(a.profile, owner))
          storage.queueRemoval(
            connection.nodeId,
            xuiEmail(a.profile, u.clientName),
            u.userUuid,
            owner,
          );
      storage.assignConnection(a.connectionId, a.profile, a.included, owner);
    }
  });
  return { ids: [...ids], removed };
}
