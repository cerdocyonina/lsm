import { z } from "zod";
import {
  clearSessionCookie,
  createSessionCookie,
  readSession,
  verifyAdminCredentials,
} from "./admin-auth";
import type { LoginRateLimiter } from "./admin-rate-limit";
import { parseDumpOrThrow } from "./app-config";
import {
  ensureUserCredentials,
  resolvedIdentityFor,
} from "./ensure-credentials";
import {
  applyAssignments,
  assignmentsSchema,
  connectionSchema,
  hostSchema,
  inventory,
  saveConnectionWithProfiles,
  pushXuiClients,
  saveServer,
  serverSchema,
  serviceSchema,
  syncInventory,
  xuiEmail,
} from "./inventory";
import {
  buildMieruUsersForNode,
  buildNaiveUsersForNode,
  buildShadowsocksUsersForNode,
  type DeclarativeUsers,
  syncNaiveNode,
} from "./naive-sync";
import { checkHttpPingRequirements, pingAllHttp, pingAllIcmp } from "./ping";
import { templateNeedsNode, templatePlaceholders } from "./placeholders";
import type { NodeRecord, ProfileRecord, Storage } from "./storage";
import { buildMultiProfileDump, buildProfileDump } from "./storage";
import { resolveServerTemplates } from "./subscription";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createProfileSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9_-]+$/,
      "Profile name must be lowercase alphanumeric, hyphens, or underscores",
    ),
});

const updateProfileSchema = z.object({
  name: z.string().min(1),
});

const createUserSchema = z.object({
  clientName: z.string().min(1),
  userUuid: z.uuid(),
});

const updateUserSchema = z
  .object({
    clientName: z.string().min(1).optional(),
    userUuid: z.uuid().optional(),
  })
  .refine(
    (input) => input.clientName !== undefined || input.userUuid !== undefined,
    { message: "Provide at least one user field to update." },
  );

const createServerSchema = z.object({
  name: z.string().min(1),
  template: z.string().min(1),
  nodeId: z.number().int().positive().nullable().optional(),
});

const reorderServersSchema = z.object({
  order: z.array(z.string().min(1)).min(1),
});

const pingServersSchema = z.object({
  servers: z.array(z.string().min(1)).optional(),
  serversExcept: z.array(z.string().min(1)).optional(),
  users: z.array(z.string().min(1)).optional(),
  usersExcept: z.array(z.string().min(1)).optional(),
  strategy: z.enum(["icmp", "http", "all"]).optional(),
});

const updateServerSchema = z
  .object({
    displayName: z.string().trim().nullable().optional(),
    name: z.string().min(1).optional(),
    template: z.string().min(1).optional(),
    nodeId: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (input) =>
      input.displayName !== undefined ||
      input.name !== undefined ||
      input.template !== undefined ||
      input.nodeId !== undefined,
    { message: "Provide at least one server field to update." },
  );

export const createNodeSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    secret: z.string().min(1),
    type: z.enum(["xui", "naive", "shadowsocks", "mieru"]).default("xui"),
    // nonnegative, not positive: naive/shadowsocks/mieru nodes have no inbound and store 0.
    inboundId: z.number().int().nonnegative().default(0),
  })
  .refine((input) => input.type !== "xui" || input.inboundId >= 1, {
    message: "inboundId >= 1 is required for xui nodes",
    path: ["inboundId"],
  });

export const updateNodeSchema = z
  .object({
    name: z.string().min(1).optional(),
    url: z.string().url().optional(),
    secret: z.string().min(1).optional(),
    type: z.enum(["xui", "naive", "shadowsocks", "mieru"]).optional(),
    inboundId: z.number().int().nonnegative().optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.url !== undefined ||
      input.secret !== undefined ||
      input.type !== undefined ||
      input.inboundId !== undefined,
    { message: "Provide at least one node field to update." },
  )
  .refine(
    (input) =>
      input.type !== "xui" ||
      input.inboundId === undefined ||
      input.inboundId >= 1,
    {
      message: "inboundId >= 1 is required for xui nodes",
      path: ["inboundId"],
    },
  );

const createAdminUserSchema = z.object({
  username: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9_-]+$/,
      "Username must be lowercase alphanumeric, hyphens, or underscores",
    ),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const updateAccountSchema = z
  .object({
    username: z
      .string()
      .min(1)
      .regex(
        /^[a-z0-9_-]+$/,
        "Username must be lowercase alphanumeric, hyphens, or underscores",
      )
      .optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .optional(),
  })
  .refine((d) => d.username !== undefined || d.newPassword !== undefined, {
    message: "Provide at least one field to update.",
  })
  .refine((d) => !d.newPassword || d.currentPassword !== undefined, {
    message: "Current password is required to set a new password.",
  });

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}

function noStoreResponse(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function adminErrorResponse(status: number, message: string): Response {
  return noStoreResponse(errorResponse(status, message));
}

/** {ip} берётся из URL ноды — без ноды ссылка ушла бы юзерам с пустым хостом. */
function ipWithoutNodeError(
  template: string,
  nodeId: number | null,
): Response | null {
  if (nodeId !== null || !templateNeedsNode(template)) return null;
  return adminErrorResponse(
    400,
    "Template uses {ip}, which is taken from the assigned node's URL — assign a node.",
  );
}

async function parseJson<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<T | Response> {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "Request body must be valid JSON.");
  }

  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(400, z.prettifyError(error));
    }

    return errorResponse(400, "Invalid request body.");
  }
}

function createSubscriptionUrl(
  baseUrl: string,
  subscriptionToken: string,
): string {
  return `${baseUrl}/${subscriptionToken}`;
}

function requireAuth(req: Request): { adminUserId: number } | Response {
  const session = readSession(req);
  if (!session) {
    return adminErrorResponse(401, "Unauthorized.");
  }
  return { adminUserId: session.adminUserId };
}

async function requirePrimaryAdmin(
  req: Request,
  storage: Storage,
): Promise<{ adminUserId: number } | Response> {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;

  const adminUser = storage.getAdminUserById(auth.adminUserId);
  if (!adminUser?.isPrimary) {
    return adminErrorResponse(403, "Forbidden. Primary admin only.");
  }
  return auth;
}

function requireProfile(
  storage: Storage,
  profileId: string,
  ownerId: number,
): ProfileRecord | Response {
  const profile = storage.getProfile(profileId, ownerId);
  if (!profile) {
    return adminErrorResponse(404, `Unknown profile: ${profileId}`);
  }
  return profile;
}

function mapUsers(
  storage: Storage,
  profileId: string,
  ownerId: number,
  baseUrl: string,
) {
  return storage.listUsers(profileId, ownerId).map((user) => ({
    clientName: user.clientName,
    userUuid: user.userUuid,
    subscriptionToken: user.subscriptionToken,
    subscriptionUrl: createSubscriptionUrl(baseUrl, user.subscriptionToken),
    createdAt: user.createdAt,
    lastFetchedAt: user.lastFetchedAt,
  }));
}

function mapServers(storage: Storage, profileId: string, ownerId: number) {
  return storage.listServerRecords(profileId, ownerId).map((server) => ({
    name: server.name,
    sortOrder: server.sortOrder,
    template: server.template,
    createdAt: server.createdAt,
    nodeId: server.nodeId,
    connectionId: server.connectionId,
    displayName: server.displayName,
  }));
}

function mapNodes(storage: Storage, ownerId: number) {
  return storage.listNodes(ownerId).map((n) => ({
    id: n.id,
    hostId: n.hostId,
    backendPath: n.backendPath,
    name: n.name,
    url: n.url,
    type: n.type,
    inboundId: n.inboundId,
    createdAt: n.createdAt,
    // secret intentionally omitted from list response
  }));
}

/** Ноды-«декларативы» (весь список пушится разом): naive, shadowsocks и mieru. */
type Health = {
  ok?: boolean;
  version?: string;
  error?: string;
  xui?: { ok: boolean; error?: string };
  caddy?: { ok: boolean; error?: string };
  shadowsocks?: { ok: boolean; error?: string };
  mieru?: { ok: boolean; error?: string };
};
async function fetchHealth(url: string, secret: string): Promise<Health> {
  try {
    const res = await fetch(`${url}/health`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10000),
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    const data = (await res.json()) as Health;
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** One agent, many backends: report its version once and each backend's own provider check. */
async function testHost(
  host: { url: string; secret: string },
  services: NodeRecord[],
) {
  if (!services.length) {
    const h = await fetchHealth(host.url, host.secret);
    return { ok: h.ok === true, version: h.version, error: h.error, services: [] };
  }
  const results = await Promise.all(
    services.map(async (n) => {
      const h = await fetchHealth(n.url, host.secret);
      const provider = {
        xui: h.xui,
        naive: h.caddy,
        shadowsocks: h.shadowsocks,
        mieru: h.mieru,
      }[n.type];
      return {
        nodeId: n.id,
        name: n.name,
        version: h.version,
        ok: h.ok === true && provider?.ok !== false,
        error: h.error ?? provider?.error,
      };
    }),
  );
  return {
    ok: results.every((r) => r.ok),
    version: results.find((r) => r.version)?.version,
    error: results.every((r) => !r.ok) ? results[0]?.error : undefined,
    services: results.map(({ version, ...r }) => r),
  };
}

/** True when an existing host gets a different agent URL or secret. */
function agentMoved(
  storage: Storage,
  ownerId: number,
  host: { id: number | null; url: string; secret: string },
): boolean {
  if (host.id === null) return false;
  const before = storage.exportHosts(ownerId).find((h) => h.id === host.id);
  if (!before) return false;
  return (
    before.url !== host.url.replace(/\/$/, "") ||
    (host.secret !== "" && host.secret !== before.secret)
  );
}

/** Services on the host that at least one profile uses. */
function usedServicesOnHost(
  storage: Storage,
  ownerId: number,
  hostId: number,
): number[] {
  const used = new Set(
    storage
      .listProfiles(ownerId)
      .flatMap((p) => storage.listServerRecords(p.name, ownerId))
      .map((s) => s.nodeId),
  );
  return storage
    .listNodes(ownerId)
    .filter((n) => n.hostId === hostId && used.has(n.id))
    .map((n) => n.id);
}

function isDeclarativeNode(node: NodeRecord): boolean {
  return (
    node.type === "naive" ||
    node.type === "shadowsocks" ||
    node.type === "mieru"
  );
}

/** Целевой список юзеров для декларативной ноды — по её типу выбираем нужный кред. */
function buildDeclarativeUsers(
  storage: Storage,
  node: NodeRecord,
  ownerId: number,
): DeclarativeUsers {
  switch (node.type) {
    case "shadowsocks":
      return buildShadowsocksUsersForNode(storage, node.id, ownerId);
    case "mieru":
      return buildMieruUsersForNode(storage, node.id, ownerId);
    default:
      return buildNaiveUsersForNode(storage, node.id, ownerId);
  }
}

async function syncUserToNodes(
  nodes: NodeRecord[],
  email: string,
  uuid: string,
  onConflict: "skip" | "overwrite" | "keep-both" = "skip",
  naiveContext?: { storage: Storage; profileName: string; ownerId: number },
) {
  return Promise.allSettled(
    nodes.map(async (node) => {
      // naive/shadowsocks/mieru are declarative: there is no per-user add. Push the whole
      // desired list and let the node re-render its config.
      if (isDeclarativeNode(node)) {
        if (!naiveContext) {
          return {
            nodeId: node.id,
            nodeName: node.name,
            result: "failed",
            msg: "declarative node requires profile context",
          };
        }
        // Union across every profile bound to this node — the node replaces its whole
        // config, so pushing one profile's list would clobber the others.
        const { users, skipped } = buildDeclarativeUsers(
          naiveContext.storage,
          node,
          naiveContext.ownerId,
        );
        const res = await syncNaiveNode(node, users);
        const skipMsg = skipped.length
          ? `skipped invalid names: ${skipped.join(", ")}`
          : undefined;
        return {
          nodeId: node.id,
          nodeName: node.name,
          result: res.error ? "failed" : "added",
          msg: [res.error, skipMsg].filter(Boolean).join("; ") || undefined,
        };
      }

      try {
        const [step] = await pushXuiClients(node, {
          clients: [
            {
              email: xuiEmail(naiveContext!.profileName, email),
              uuid,
              legacyEmail: email,
            },
          ],
          onConflict,
        });
        return {
          nodeId: node.id,
          nodeName: node.name,
          result: !step || !step.ok ? "failed" : step.kind === "conflict" ? "skipped" : step.kind,
          msg: step?.error ?? (step?.kind === "conflict" ? step.detail : undefined),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { nodeId: node.id, nodeName: node.name, result: "failed", msg };
      }
    }),
  );
}

async function deleteUserFromNodes(
  nodes: NodeRecord[],
  email: string,
  uuid: string,
  naiveContext?: { storage: Storage; profileName: string; ownerId: number },
) {
  return Promise.allSettled(
    nodes.map(async (node) => {
      // The user row is already gone from storage by now, so re-pushing the
      // current list is exactly "delete" for a declarative backend.
      if (isDeclarativeNode(node)) {
        if (!naiveContext) {
          return {
            nodeId: node.id,
            nodeName: node.name,
            result: "failed",
            msg: "declarative node requires profile context",
          };
        }
        // Union across every profile bound to this node — the node replaces its whole
        // config, so pushing one profile's list would clobber the others.
        const { users, skipped } = buildDeclarativeUsers(
          naiveContext.storage,
          node,
          naiveContext.ownerId,
        );
        const res = await syncNaiveNode(node, users);
        const skipMsg = skipped.length
          ? `skipped invalid names: ${skipped.join(", ")}`
          : undefined;
        return {
          nodeId: node.id,
          nodeName: node.name,
          result: res.error ? "failed" : "deleted",
          msg: [res.error, skipMsg].filter(Boolean).join("; ") || undefined,
        };
      }

      try {
        const steps = await pushXuiClients(node, {
          clients: [],
          remove: [{ email: xuiEmail(naiveContext!.profileName, email), uuid }],
          onConflict: "skip",
        });
        const failed = steps.find((s) => !s.ok);
        return {
          nodeId: node.id,
          nodeName: node.name,
          result: failed ? "failed" : steps.some((s) => s.kind === "not-found") ? "not_found" : "deleted",
          msg: failed?.error,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { nodeId: node.id, nodeName: node.name, result: "failed", msg };
      }
    }),
  );
}

// Extracts profileId and the sub-path under /profiles/:profileId
function extractProfileRoute(
  pathname: string,
): { profileId: string; subPath: string } | null {
  const match = pathname.match(/^\/profiles\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    profileId: decodeURIComponent(match[1] ?? ""),
    subPath: match[2] ?? "/",
  };
}

function getUserSubPath(subPath: string): string | null {
  const match = subPath.match(/^\/users\/([^/]+)$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function getServerSubPath(subPath: string): string | null {
  const match = subPath.match(/^\/servers\/([^/]+)$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

export async function handleAdminApiRequest(
  req: Request,
  pathname: string,
  storage: Storage,
  createSubscriptionToken: (profileId: string, name: string) => string,
  adminBasePath: string,
  baseUrl: string,
  loginRateLimiter: LoginRateLimiter,
  clientIp: string,
  subLinkSecret: string,
): Promise<Response | null> {
  const expectedPrefix = `${adminBasePath}/api`;
  const adminPathname = pathname.startsWith(expectedPrefix)
    ? pathname.slice(expectedPrefix.length) || "/"
    : null;

  if (!adminPathname) {
    return null;
  }

  if (adminPathname === "/auth/login" && req.method === "POST") {
    const parsed = await parseJson(req, loginSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    const loginStatus = loginRateLimiter.check(clientIp, parsed.username);
    if (!loginStatus.allowed) {
      const response = noStoreResponse(
        errorResponse(429, "Too many login attempts. Try again later."),
      );
      response.headers.set(
        "Retry-After",
        String(loginStatus.retryAfterSeconds),
      );
      return response;
    }

    const adminUserId = await verifyAdminCredentials(
      parsed.username,
      parsed.password,
      storage,
    );

    if (adminUserId === null) {
      const failedAttempt = loginRateLimiter.recordFailure(
        clientIp,
        parsed.username,
      );
      const statusCode = failedAttempt.allowed ? 401 : 429;
      const response = noStoreResponse(
        errorResponse(
          statusCode,
          failedAttempt.allowed
            ? "Invalid credentials."
            : "Too many login attempts. Try again later.",
        ),
      );
      if (!failedAttempt.allowed) {
        response.headers.set(
          "Retry-After",
          String(failedAttempt.retryAfterSeconds),
        );
      }
      return response;
    }

    loginRateLimiter.reset(clientIp, parsed.username);

    const adminUserRecord = storage.getAdminUserById(adminUserId)!;
    return noStoreResponse(
      jsonResponse(
        {
          ok: true,
          username: adminUserRecord.username,
          isPrimary: adminUserRecord.isPrimary,
        },
        {
          headers: {
            "Set-Cookie": createSessionCookie(adminUserId),
          },
        },
      ),
    );
  }

  if (adminPathname === "/auth/logout" && req.method === "POST") {
    return noStoreResponse(
      new Response(null, {
        status: 204,
        headers: {
          "Set-Cookie": clearSessionCookie(),
        },
      }),
    );
  }

  if (adminPathname === "/session" && req.method === "GET") {
    const auth = requireAuth(req);
    if (auth instanceof Response) return auth;

    const adminUser = storage.getAdminUserById(auth.adminUserId);
    if (!adminUser) {
      return adminErrorResponse(401, "Unauthorized.");
    }

    return noStoreResponse(
      jsonResponse({
        username: adminUser.username,
        isPrimary: adminUser.isPrimary,
      }),
    );
  }

  // All routes below require auth
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { adminUserId } = auth;

  // Admin users management (primary admin only)
  if (adminPathname === "/admin-users" && req.method === "GET") {
    const primaryCheck = await requirePrimaryAdmin(req, storage);
    if (primaryCheck instanceof Response) return primaryCheck;
    return noStoreResponse(
      jsonResponse({ adminUsers: storage.listAdminUsers() }),
    );
  }

  if (adminPathname === "/admin-users" && req.method === "POST") {
    const primaryCheck = await requirePrimaryAdmin(req, storage);
    if (primaryCheck instanceof Response) return primaryCheck;

    const parsed = await parseJson(req, createAdminUserSchema);
    if (parsed instanceof Response) return noStoreResponse(parsed);

    const passwordHash = await Bun.password.hash(parsed.password);
    try {
      storage.createAdminUser(parsed.username, passwordHash, Date.now());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create admin user.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ adminUsers: storage.listAdminUsers() }, { status: 201 }),
    );
  }

  const adminUserMatch = adminPathname.match(/^\/admin-users\/(\d+)$/);
  if (adminUserMatch && req.method === "DELETE") {
    const primaryCheck = await requirePrimaryAdmin(req, storage);
    if (primaryCheck instanceof Response) return primaryCheck;

    const targetId = parseInt(adminUserMatch[1]!, 10);

    if (targetId === adminUserId) {
      return adminErrorResponse(400, "Cannot delete your own account.");
    }

    const targetUser = storage.getAdminUserById(targetId);
    if (!targetUser) {
      return adminErrorResponse(404, `Unknown admin user: ${targetId}`);
    }
    if (targetUser.isPrimary) {
      return adminErrorResponse(400, "Cannot delete the primary admin.");
    }

    storage.deleteAdminUser(targetId);
    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Account self-service (subadmins only)
  if (adminPathname === "/account" && req.method === "PATCH") {
    const adminUser = storage.getAdminUserById(adminUserId);
    if (!adminUser) return adminErrorResponse(401, "Unauthorized.");
    if (adminUser.isPrimary) {
      return adminErrorResponse(
        403,
        "Primary admin credentials are managed via environment variables.",
      );
    }

    const parsed = await parseJson(req, updateAccountSchema);
    if (parsed instanceof Response) return noStoreResponse(parsed);

    if (parsed.newPassword !== undefined) {
      const match = await Bun.password.verify(
        parsed.currentPassword!,
        adminUser.passwordHash,
      );
      if (!match)
        return adminErrorResponse(400, "Current password is incorrect.");
    }

    const updates: { username?: string; passwordHash?: string } = {};
    if (parsed.username !== undefined) updates.username = parsed.username;
    if (parsed.newPassword !== undefined)
      updates.passwordHash = await Bun.password.hash(parsed.newPassword);

    try {
      storage.updateAdminUser(adminUserId, updates);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update account.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Shared infrastructure, scoped to the signed-in administrator.
  if (adminPathname === "/inventory" && req.method === "GET")
    return noStoreResponse(jsonResponse(inventory(storage, adminUserId)));
  const hostTest = adminPathname.match(/^\/inventory\/hosts\/(\d+)\/test$/);
  if (hostTest && req.method === "POST") {
    const host = storage
      .exportHosts(adminUserId)
      .find((h) => h.id === Number(hostTest[1]));
    if (!host) return adminErrorResponse(404, "Unknown host");
    return noStoreResponse(
      jsonResponse(
        await testHost(
          host,
          storage.listNodes(adminUserId).filter((n) => n.hostId === host.id),
        ),
      ),
    );
  }
  if (adminPathname.startsWith("/inventory/") && req.method === "POST") {
    try {
      const action = adminPathname.slice("/inventory/".length);
      let id: number | undefined;
      let syncResults: Awaited<ReturnType<typeof syncInventory>> = [];
      // Saves return as soon as the DB is updated; the UI pushes these services afterwards
      // via /inventory/sync, so a slow or dead agent never holds up an edit.
      let pendingSync: number[] = [];
      let dryRun = false;
      if (action === "discover") {
        const p = await parseJson(req, hostSchema);
        if (p instanceof Response) return p;
        const saved = p.id
          ? storage.exportHosts(adminUserId).find((h) => h.id === p.id)
          : null;
        const secret = p.secret || saved?.secret;
        if (!secret) throw new Error("Agent secret is required");
        const response = await fetch(`${p.url.replace(/\/$/, "")}/backends`, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(10000),
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        if (!response.ok)
          throw new Error(
            "Backend discovery requires an updated lsmnode. Services can also be added manually.",
          );
        const discovered = z
          .object({
            backends: z.array(
              z.object({
                name: z.string(),
                kind: z.enum(["xui", "naive", "shadowsocks", "mieru"]),
                path: z.string().regex(/^(\/[A-Za-z0-9_-]+)*$/),
              }),
            ),
          })
          .parse(await response.json());
        return noStoreResponse(jsonResponse(discovered));
      } else if (action === "setup") {
        const p = await parseJson(
          req,
          z.object({
            host: hostSchema,
            services: z
              .array(
                z
                  .object(serviceSchema.shape)
                  .omit({ hostId: true })
                  .extend({
                    template: z.string().trim().min(1),
                    profiles: z.array(z.string()),
                  })
                  .refine(
                    (s) => s.type !== "xui" || s.inboundId > 0,
                    "3x-ui requires an inbound ID",
                  ),
              )
              .min(1),
          }),
        );
        if (p instanceof Response) return p;
        const ids: number[] = [];
        const moved = agentMoved(storage, adminUserId, p.host);
        storage.transaction(() => {
          id = storage.saveHost(
            p.host.id,
            p.host.name,
            p.host.url,
            p.host.secret,
            adminUserId,
          );
          for (const service of p.services) {
            const nodeId = storage.findOrCreateService(
              id,
              service.type,
              service.path,
              service.type === "xui" ? service.inboundId : 0,
              service.name,
              adminUserId,
            );
            const connectionId = storage.saveConnection(
              null,
              service.name,
              service.template,
              nodeId,
              adminUserId,
            );
            for (const profile of service.profiles)
              storage.assignConnection(
                connectionId,
                profile,
                true,
                adminUserId,
              );
            if (service.profiles.length) ids.push(nodeId);
          }
        });
        if (moved) ids.push(...usedServicesOnHost(storage, adminUserId, id!));
        pendingSync = [...new Set(ids)];
      } else if (action === "hosts") {
        const p = await parseJson(req, hostSchema);
        if (p instanceof Response) return p;
        // A rename touches nothing on the agent; only a new address or secret needs a push.
        const moved = agentMoved(storage, adminUserId, p);
        id = storage.saveHost(p.id, p.name, p.url, p.secret, adminUserId);
        if (moved) pendingSync = usedServicesOnHost(storage, adminUserId, id);
      } else if (action === "services") {
        const p = await parseJson(req, serviceSchema);
        if (p instanceof Response) return p;
        id = storage.saveService(
          p.id,
          p.hostId,
          p.name,
          p.path,
          p.type,
          p.inboundId,
          adminUserId,
        );
        if (p.id !== null) pendingSync = [id];
      } else if (action === "connections") {
        const p = await parseJson(
          req,
          connectionSchema.safeExtend({
            profiles: z.array(z.string()).optional(),
          }),
        );
        if (p instanceof Response) return p;
        const saved = saveConnectionWithProfiles(storage, adminUserId, p);
        id = saved.id;
        pendingSync = [...saved.ids];
      } else if (action === "servers") {
        const p = await parseJson(req, serverSchema);
        if (p instanceof Response) return p;
        const saved = saveServer(storage, adminUserId, p);
        id = saved.id;
        pendingSync = [...saved.ids];
      } else if (action === "assignments") {
        const p = await parseJson(req, assignmentsSchema);
        if (p instanceof Response) return p;
        // 3x-ui revocations are queued in the DB here, so a later push still performs them.
        pendingSync = applyAssignments(storage, adminUserId, p).ids;
      } else if (action === "sync") {
        const p = await parseJson(
          req,
          z.object({
            ids: z.array(z.number().int().positive()),
            // 3x-ui only: what to do when a client exists with another UUID.
            onConflict: z.enum(["skip", "overwrite", "keep-both"]).default("skip"),
            dryRun: z.boolean().default(false),
          }),
        );
        if (p instanceof Response) return p;
        dryRun = p.dryRun;
        syncResults = await syncInventory(storage, adminUserId, p.ids, new Map(), {
          onConflict: p.onConflict,
          dryRun: p.dryRun,
        });
      } else return adminErrorResponse(404, "Unknown inventory action");
      // An unused service stays until a push to it succeeds, so revocations aren't lost.
      if (!dryRun)
        storage.pruneUnusedServices(adminUserId, [
          ...pendingSync,
          ...syncResults.filter((r) => !r.ok).map((r) => r.nodeId),
        ]);
      return noStoreResponse(
        jsonResponse({
          ...inventory(storage, adminUserId),
          id,
          syncResults,
          pendingSync,
        }),
      );
    } catch (e) {
      return adminErrorResponse(
        400,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  const inventoryDelete = adminPathname.match(
    /^\/inventory\/(hosts|services|connections)\/(\d+)$/,
  );
  if (inventoryDelete && req.method === "DELETE") {
    try {
      const id = Number(inventoryDelete[2]);
      const kind = inventoryDelete[1];
      if (kind === "hosts") storage.deleteHost(id, adminUserId);
      if (kind === "services") {
        if (storage.listConnections(adminUserId).some((c) => c.nodeId === id))
          throw new Error("Remove or reassign the service's connections first");
        storage.removeNode(id, adminUserId);
      }
      let pendingSync: number[] = [];
      if (kind === "connections") {
        const removals = storage
          .listProfiles(adminUserId)
          .filter((p) =>
            storage
              .listServerRecords(p.name, adminUserId)
              .some((c) => c.connectionId === id),
          )
          .map((p) => ({ connectionId: id, profile: p.name, included: false }));
        const changed = applyAssignments(storage, adminUserId, {
          assignments: removals,
        });
        storage.deleteConnection(id, adminUserId);
        pendingSync = changed.ids;
        storage.pruneUnusedServices(adminUserId, pendingSync);
      }
      return noStoreResponse(
        jsonResponse({
          ...inventory(storage, adminUserId),
          syncResults: [],
          pendingSync,
        }),
      );
    } catch (e) {
      return adminErrorResponse(
        400,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Profile list and create
  if (adminPathname === "/profiles" && req.method === "GET") {
    return noStoreResponse(
      jsonResponse({ profiles: storage.listProfiles(adminUserId) }),
    );
  }

  if (adminPathname === "/profiles" && req.method === "POST") {
    const parsed = await parseJson(req, createProfileSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      storage.createProfile(parsed.name, adminUserId, Date.now());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create profile.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse(
        { profiles: storage.listProfiles(adminUserId) },
        { status: 201 },
      ),
    );
  }

  // Node routes (scoped by owner)
  if (adminPathname === "/nodes" && req.method === "GET") {
    return noStoreResponse(
      jsonResponse({ nodes: mapNodes(storage, adminUserId) }),
    );
  }

  if (adminPathname === "/nodes" && req.method === "POST") {
    const parsed = await parseJson(req, createNodeSchema);
    if (parsed instanceof Response) return noStoreResponse(parsed);

    let node;
    try {
      node = storage.addNode(
        parsed.name,
        parsed.url,
        parsed.secret,
        parsed.inboundId,
        adminUserId,
        Date.now(),
        parsed.type,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add node.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse(
        { nodes: mapNodes(storage, adminUserId), node: { id: node.id } },
        { status: 201 },
      ),
    );
  }

  const nodeMatch = adminPathname.match(/^\/nodes\/(\d+)(\/.*)?$/);
  if (nodeMatch) {
    const nodeId = parseInt(nodeMatch[1]!, 10);
    const nodeSubPath = nodeMatch[2] ?? "/";

    if (nodeSubPath === "/" && req.method === "PATCH") {
      const parsed = await parseJson(req, updateNodeSchema);
      if (parsed instanceof Response) return noStoreResponse(parsed);

      const existing = storage.getNode(nodeId, adminUserId);
      if (existing) {
        const effectiveType = parsed.type ?? existing.type;
        const effectiveInboundId = parsed.inboundId ?? existing.inboundId;
        if (effectiveType === "xui" && effectiveInboundId < 1) {
          return adminErrorResponse(
            400,
            "inboundId >= 1 is required for xui nodes",
          );
        }
      }

      const updated = storage.updateNode(nodeId, adminUserId, parsed);
      if (!updated) return adminErrorResponse(404, `Unknown node: ${nodeId}`);

      return noStoreResponse(
        jsonResponse({ nodes: mapNodes(storage, adminUserId) }),
      );
    }

    if (nodeSubPath === "/" && req.method === "DELETE") {
      const removed = storage.removeNode(nodeId, adminUserId);
      if (!removed) return adminErrorResponse(404, `Unknown node: ${nodeId}`);

      return noStoreResponse(new Response(null, { status: 204 }));
    }

    if (nodeSubPath === "/test" && req.method === "POST") {
      const node = storage.getNode(nodeId, adminUserId);
      if (!node) return adminErrorResponse(404, `Unknown node: ${nodeId}`);

      try {
        const res = await fetch(`${node.url}/health`, {
          headers: { Authorization: `Bearer ${node.secret}` },
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        const data = (await res.json()) as {
          ok: boolean;
          version?: string;
          commit?: string;
          date?: string;
          xui?: { ok: boolean; error?: string };
          caddy?: { ok: boolean; error?: string };
          shadowsocks?: { ok: boolean; error?: string };
          mieru?: { ok: boolean; error?: string };
        };
        return noStoreResponse(
          jsonResponse({
            ok: data.ok === true,
            version: data.version,
            commit: data.commit,
            date: data.date,
            xui: data.xui,
            caddy: data.caddy,
            shadowsocks: data.shadowsocks,
            mieru: data.mieru,
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return noStoreResponse(jsonResponse({ ok: false, error: msg }));
      }
    }
  }

  // Export all profiles
  if (adminPathname === "/export" && req.method === "GET") {
    const dump = buildMultiProfileDump(storage, adminUserId);
    return noStoreResponse(jsonResponse(dump));
  }

  // Import (multi-profile format only at this endpoint)
  if (adminPathname === "/import" && req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return adminErrorResponse(400, "Request body must be valid JSON.");
    }

    let parsed;
    try {
      parsed = parseDumpOrThrow(body);
    } catch (error) {
      return adminErrorResponse(
        400,
        error instanceof Error ? error.message : "Invalid format.",
      );
    }

    if (parsed.kind !== "multi-profile") {
      return adminErrorResponse(
        400,
        "Expected a multi-profile dump. Use /profiles/:profileId/import for single-profile or legacy imports.",
      );
    }

    storage.mergeAllFromMultiProfileDump(parsed.data, adminUserId);
    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Profile-scoped routes: /profiles/:profileId/...
  const profileRoute = extractProfileRoute(adminPathname);
  if (!profileRoute) {
    return adminErrorResponse(404, "Not found.");
  }

  const { profileId, subPath } = profileRoute;

  // Profile rename and delete: /profiles/:profileId with no subpath
  if (subPath === "/") {
    if (req.method === "PATCH") {
      const parsed = await parseJson(req, updateProfileSchema);
      if (parsed instanceof Response) {
        return noStoreResponse(parsed);
      }

      const renamed = storage.renameProfile(
        profileId,
        parsed.name,
        adminUserId,
      );
      if (!renamed) {
        return adminErrorResponse(404, `Unknown profile: ${profileId}`);
      }

      return noStoreResponse(
        jsonResponse({ profiles: storage.listProfiles(adminUserId) }),
      );
    }

    if (req.method === "DELETE") {
      const deleted = storage.deleteProfile(profileId, adminUserId);
      if (!deleted) {
        return adminErrorResponse(404, `Unknown profile: ${profileId}`);
      }

      return noStoreResponse(new Response(null, { status: 204 }));
    }

    return adminErrorResponse(405, "Method not allowed.");
  }

  // All sub-routes require the profile to exist (and belong to this admin)
  const profileOrError = requireProfile(storage, profileId, adminUserId);
  if (profileOrError instanceof Response) {
    return profileOrError;
  }

  // Export single profile
  if (subPath === "/export" && req.method === "GET") {
    const dump = buildProfileDump(storage, profileId, adminUserId);
    return noStoreResponse(jsonResponse(dump));
  }

  // Import into a specific profile (single-profile or legacy format)
  if (subPath === "/import" && req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return adminErrorResponse(400, "Request body must be valid JSON.");
    }

    let parsed;
    try {
      parsed = parseDumpOrThrow(body);
    } catch (error) {
      return adminErrorResponse(
        400,
        error instanceof Error ? error.message : "Invalid format.",
      );
    }

    if (parsed.kind === "multi-profile") {
      return adminErrorResponse(
        400,
        "Multi-profile dumps must be imported via POST /import.",
      );
    }

    if (parsed.kind === "single-profile") {
      storage.mergeProfileFromFullDump(profileId, parsed.data, adminUserId);
    } else {
      storage.mergeProfileFromLegacyConfig(
        profileId,
        parsed.data,
        subLinkSecret,
        adminUserId,
      );
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Users
  if (subPath === "/users" && req.method === "GET") {
    return noStoreResponse(
      jsonResponse({
        users: mapUsers(storage, profileId, adminUserId, baseUrl),
      }),
    );
  }

  if (subPath === "/users" && req.method === "POST") {
    const parsed = await parseJson(req, createUserSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      storage.addUser(
        profileId,
        parsed.clientName,
        createSubscriptionToken(profileId, parsed.clientName),
        parsed.userUuid,
        Date.now(),
        adminUserId,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add user.";
      return adminErrorResponse(400, message);
    }

    const nodes = storage.listNodesForProfile(profileId, adminUserId);
    const syncSettled = await syncUserToNodes(
      nodes,
      parsed.clientName,
      parsed.userUuid,
      "skip",
      {
        storage,
        profileName: profileId,
        ownerId: adminUserId,
      },
    );
    const syncResults = syncSettled.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { result: "failed", msg: String(r.reason) },
    );

    return noStoreResponse(
      jsonResponse(
        {
          users: mapUsers(storage, profileId, adminUserId, baseUrl),
          syncResults,
        },
        { status: 201 },
      ),
    );
  }

  const userSyncMatch = subPath.match(/^\/users\/([^/]+)\/sync$/);
  if (userSyncMatch && req.method === "POST") {
    const clientName = decodeURIComponent(userSyncMatch[1]!);
    const users = storage.listUsers(profileId, adminUserId);
    const user = users.find((u) => u.clientName === clientName);
    if (!user) return adminErrorResponse(404, `Unknown client: ${clientName}`);

    const nodes = storage.listNodesForProfile(profileId, adminUserId);
    if (nodes.length === 0) {
      return noStoreResponse(jsonResponse({ syncResults: [] }));
    }

    const syncSettled = await syncUserToNodes(
      nodes,
      user.clientName,
      user.userUuid,
      "overwrite",
      {
        storage,
        profileName: profileId,
        ownerId: adminUserId,
      },
    );
    const syncResults = syncSettled.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { result: "failed", msg: String(r.reason) },
    );
    return noStoreResponse(jsonResponse({ syncResults }));
  }

  const userPathName = getUserSubPath(subPath);
  if (userPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateUserSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      if (parsed.clientName !== undefined) {
        const renamed = storage.renameUser(
          profileId,
          userPathName,
          parsed.clientName,
          adminUserId,
        );
        if (!renamed) {
          return adminErrorResponse(404, `Unknown client: ${userPathName}`);
        }
      }

      if (parsed.userUuid !== undefined) {
        const targetName = parsed.clientName ?? userPathName;
        const updated = storage.setUserUuid(
          profileId,
          targetName,
          parsed.userUuid,
          adminUserId,
        );
        if (!updated) {
          return adminErrorResponse(404, `Unknown client: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update user.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({
        users: mapUsers(storage, profileId, adminUserId, baseUrl),
      }),
    );
  }

  if (userPathName && req.method === "DELETE") {
    let nodeIds: number[] = [];
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const body = (await req.json()) as { nodeIds?: unknown };
        if (Array.isArray(body.nodeIds)) {
          nodeIds = body.nodeIds.filter(
            (n): n is number =>
              typeof n === "number" && Number.isInteger(n) && n > 0,
          );
        }
      } catch {}
    }

    const user = storage
      .listUsers(profileId, adminUserId)
      .find((u) => u.clientName === userPathName);
    const removed = storage.removeUser(profileId, userPathName, adminUserId);
    if (!removed || !user) {
      return adminErrorResponse(404, `Unknown client: ${userPathName}`);
    }

    if (nodeIds.length > 0) {
      const profileNodes = storage.listNodesForProfile(profileId, adminUserId);
      const selectedNodes = profileNodes.filter((n) => nodeIds.includes(n.id));
      const settled = await deleteUserFromNodes(selectedNodes, userPathName, user.userUuid, {
        storage,
        profileName: profileId,
        ownerId: adminUserId,
      });
      const syncResults = settled.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { result: "failed", msg: String(r.reason) },
      );
      return noStoreResponse(jsonResponse({ syncResults }));
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Servers
  if (subPath === "/servers" && req.method === "GET") {
    return noStoreResponse(
      jsonResponse({ servers: mapServers(storage, profileId, adminUserId) }),
    );
  }

  if (subPath === "/servers" && req.method === "POST") {
    const parsed = await parseJson(req, createServerSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }
    const ipError = ipWithoutNodeError(parsed.template, parsed.nodeId ?? null);
    if (ipError) return ipError;

    try {
      storage.addServer(
        profileId,
        parsed.name,
        parsed.template,
        Date.now(),
        adminUserId,
        parsed.nodeId ?? null,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add server.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse(
        { servers: mapServers(storage, profileId, adminUserId) },
        { status: 201 },
      ),
    );
  }

  if (subPath === "/servers/order" && req.method === "PUT") {
    const parsed = await parseJson(req, reorderServersSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    storage.reorderServers(profileId, parsed.order, adminUserId);
    return noStoreResponse(
      jsonResponse({ servers: mapServers(storage, profileId, adminUserId) }),
    );
  }

  if (subPath === "/servers/ping" && req.method === "POST") {
    const parsed = await parseJson(req, pingServersSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    const strategy = parsed.strategy ?? "all";
    let records = storage.listServerRecords(profileId, adminUserId);
    const serverSet =
      parsed.servers && parsed.servers.length > 0
        ? new Set(parsed.servers)
        : null;
    const serverExceptSet =
      parsed.serversExcept && parsed.serversExcept.length > 0
        ? new Set(parsed.serversExcept)
        : null;
    if (serverSet) records = records.filter((s) => serverSet.has(s.name));
    else if (serverExceptSet)
      records = records.filter((s) => !serverExceptSet.has(s.name));

    if (strategy !== "icmp") {
      const httpReq = checkHttpPingRequirements();
      if (!httpReq.ok) {
        return adminErrorResponse(
          422,
          `HTTP ping unavailable: ${httpReq.error}`,
        );
      }
    }

    // {ip} подставлен заранее: и ICMP, и http-проба разбирают host:port прямо из шаблона.
    const templates = resolveServerTemplates(storage, records, adminUserId);
    const servers = records.map((s, i) => ({
      name: s.name,
      template: templates[i]!,
    }));
    let userRecords = storage.listUsers(profileId, adminUserId);
    const userSet =
      parsed.users && parsed.users.length > 0 ? new Set(parsed.users) : null;
    const userExceptSet =
      parsed.usersExcept && parsed.usersExcept.length > 0
        ? new Set(parsed.usersExcept)
        : null;
    if (userSet)
      userRecords = userRecords.filter((u) => userSet.has(u.clientName));
    else if (userExceptSet)
      userRecords = userRecords.filter((u) => !userExceptSet.has(u.clientName));
    // Пингу нужны те же per-user креды, что и подписке: uuid для vless, {user}/{pass} для
    // naive, {sskey} для ss, {user}/{mpass} для mieru. Резолвим идентичность точно так же,
    // как рендер подписки.
    const required = [
      ...new Set(
        templates.flatMap((template) => templatePlaceholders(template)),
      ),
    ];
    const users = userRecords.map((u) => ({
      clientName: u.clientName,
      identity: resolvedIdentityFor(
        u,
        ensureUserCredentials(storage, u, required),
      ),
    }));

    const [icmp, http] = await Promise.all([
      strategy !== "http" ? pingAllIcmp(servers) : Promise.resolve(null),
      strategy !== "icmp" ? pingAllHttp(servers, users) : Promise.resolve(null),
    ]);

    return noStoreResponse(jsonResponse({ icmp, http }));
  }

  const serverPathName = getServerSubPath(subPath);
  if (serverPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateServerSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }
    // Проверяем ИТОГОВОЕ состояние: {ip} можно добавить в шаблон, а можно отвязать ноду.
    const existing = storage
      .listServerRecords(profileId, adminUserId)
      .find((s) => s.name === serverPathName);
    if (existing) {
      const ipError = ipWithoutNodeError(
        parsed.template ?? existing.template,
        parsed.nodeId !== undefined ? parsed.nodeId : existing.nodeId,
      );
      if (ipError) return ipError;
    }

    try {
      if (parsed.name !== undefined) {
        const renamed = storage.renameServer(
          profileId,
          serverPathName,
          parsed.name,
          adminUserId,
        );
        if (!renamed) {
          return adminErrorResponse(
            404,
            `Unknown server name: ${serverPathName}`,
          );
        }
      }

      if (parsed.displayName !== undefined)
        storage.setDisplayName(
          profileId,
          parsed.name ?? serverPathName,
          parsed.displayName,
          adminUserId,
        );
      if (parsed.template !== undefined) {
        const targetName = parsed.name ?? serverPathName;
        const updated = storage.setServerUrl(
          profileId,
          targetName,
          parsed.template,
          adminUserId,
        );
        if (!updated) {
          return adminErrorResponse(404, `Unknown server name: ${targetName}`);
        }
      }

      if (parsed.nodeId !== undefined) {
        const targetName = parsed.name ?? serverPathName;
        const updated = storage.setServerNode(
          profileId,
          targetName,
          parsed.nodeId,
          adminUserId,
        );
        if (!updated) {
          return adminErrorResponse(404, `Unknown server name: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update server.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ servers: mapServers(storage, profileId, adminUserId) }),
    );
  }

  if (serverPathName && req.method === "DELETE") {
    const removed = storage.removeServer(
      profileId,
      serverPathName,
      adminUserId,
    );
    if (!removed) {
      return adminErrorResponse(404, `Unknown server name: ${serverPathName}`);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  return adminErrorResponse(404, "Not found.");
}
