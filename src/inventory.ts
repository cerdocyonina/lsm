import { z } from "zod";
import {
  buildMieruUsersForNode,
  buildNaiveUsersForNode,
  buildShadowsocksUsersForNode,
  syncNaiveNode,
} from "./naive-sync";
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
    type: z.enum(["xui", "naive", "shadowsocks", "mieru"]),
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
};
const queues = new Map<number, Promise<unknown>>();
/** Serialize full-list pushes so a stale request can never finish after a newer assignment. */
export async function syncInventory(
  storage: Storage,
  owner: number,
  ids: number[],
  removed: Map<number, { clientName: string; userUuid: string }[]> = new Map(),
): Promise<InventorySyncResult[]> {
  for (const [id, users] of removed)
    if (storage.getNode(id, owner)?.type === "xui")
      for (const u of users)
        storage.queueRemoval(id, u.clientName, u.userUuid, owner);
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
            if (node.type !== "xui") {
              const build =
                node.type === "naive"
                  ? buildNaiveUsersForNode
                  : node.type === "mieru"
                    ? buildMieruUsersForNode
                    : buildShadowsocksUsersForNode;
              const list = build(storage, id, owner);
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
            }
            const users = storage
              .listProfiles(owner)
              .filter((p) =>
                storage
                  .listNodesForProfile(p.name, owner)
                  .some((n) => n.id === id),
              )
              .flatMap((p) => storage.listUsers(p.name, owner));
            const pending = storage.pendingRemovals(id, owner);
            for (const u of pending)
              if (!users.some((v) => v.userUuid === u.userUuid))
                await call(node, "delete-user", { email: u.clientName });
            for (const u of users)
              await call(node, "sync-user", {
                email: u.clientName,
                uuid: u.userUuid,
                inboundId: node.inboundId,
                onConflict: "skip",
              });
            storage.clearRemovals(
              id,
              owner,
              pending.map((u) => u.userUuid),
            );
            return {
              nodeId: id,
              name: node.name,
              ok: true,
              synced: users.length,
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
async function call(node: NodeRecord, action: string, body: unknown) {
  const response = await fetch(`${node.url}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${node.secret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  const result = (await response.json()) as {
    error?: string;
    result?: string;
    msg?: string;
  };
  if (!response.ok || result.error || result.result === "failed")
    throw new Error(
      result.error ?? result.msg ?? `Agent returned ${response.status}`,
    );
}

export function applyAssignments(
  storage: Storage,
  owner: number,
  body: z.infer<typeof assignmentsSchema>,
) {
  const ids = new Set<number>();
  const removed = new Map<number, { clientName: string; userUuid: string }[]>();
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
      if (connection.nodeId !== null && (a.included || wasIncluded)) {
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
            u.clientName,
            u.userUuid,
            owner,
          );
      storage.assignConnection(a.connectionId, a.profile, a.included, owner);
    }
  });
  return { ids: [...ids], removed };
}
