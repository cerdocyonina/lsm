import { z } from "zod";
import {
  clearSessionCookie,
  createSessionCookie,
  readSession,
  verifyAdminCredentials,
} from "./admin-auth";
import type { LoginRateLimiter } from "./admin-rate-limit";
import { parseDumpOrThrow } from "./app-config";
import { buildNaiveUsers, syncNaiveNode } from "./naive-sync";
import { checkHttpPingRequirements, pingAllHttp, pingAllIcmp } from "./ping";
import { buildMultiProfileDump, buildProfileDump } from "./storage";
import type { NodeRecord, ProfileRecord, Storage } from "./storage";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createProfileSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_-]+$/, "Profile name must be lowercase alphanumeric, hyphens, or underscores"),
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
    name: z.string().min(1).optional(),
    template: z.string().min(1).optional(),
    nodeId: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (input) => input.name !== undefined || input.template !== undefined || input.nodeId !== undefined,
    { message: "Provide at least one server field to update." },
  );

export const createNodeSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    secret: z.string().min(1),
    type: z.enum(["xui", "naive"]).default("xui"),
    // nonnegative, not positive: naive nodes have no inbound and store 0.
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
    type: z.enum(["xui", "naive"]).optional(),
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
  .refine((input) => input.type !== "xui" || input.inboundId === undefined || input.inboundId >= 1, {
    message: "inboundId >= 1 is required for xui nodes",
    path: ["inboundId"],
  });

const syncUsersSchema = z.object({
  onConflict: z.enum(["skip", "overwrite", "keep-both", "safe"]).default("overwrite"),
});

const createAdminUserSchema = z.object({
  username: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, "Username must be lowercase alphanumeric, hyphens, or underscores"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const updateAccountSchema = z
  .object({
    username: z
      .string()
      .min(1)
      .regex(/^[a-z0-9_-]+$/, "Username must be lowercase alphanumeric, hyphens, or underscores")
      .optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(8, "Password must be at least 8 characters").optional(),
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

function requireProfile(storage: Storage, profileId: string, ownerId: number): ProfileRecord | Response {
  const profile = storage.getProfile(profileId, ownerId);
  if (!profile) {
    return adminErrorResponse(404, `Unknown profile: ${profileId}`);
  }
  return profile;
}

function mapUsers(storage: Storage, profileId: string, ownerId: number, baseUrl: string) {
  return storage.listUsers(profileId, ownerId).map((user) => ({
    clientName: user.clientName,
    userUuid: user.userUuid,
    subscriptionToken: user.subscriptionToken,
    subscriptionUrl: createSubscriptionUrl(baseUrl, user.subscriptionToken),
    createdAt: user.createdAt,
  }));
}

function mapServers(storage: Storage, profileId: string, ownerId: number) {
  return storage.listServerRecords(profileId, ownerId).map((server) => ({
    name: server.name,
    sortOrder: server.sortOrder,
    template: server.template,
    createdAt: server.createdAt,
    nodeId: server.nodeId,
  }));
}

function mapNodes(storage: Storage, ownerId: number) {
  return storage.listNodes(ownerId).map((n) => ({
    id: n.id,
    name: n.name,
    url: n.url,
    type: n.type,
    inboundId: n.inboundId,
    createdAt: n.createdAt,
    // secret intentionally omitted from list response
  }));
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
      // Caddy is declarative: there is no per-user add. Push the whole desired
      // list and let the node re-render its config.
      if (node.type === "naive") {
        if (!naiveContext) {
          return { nodeId: node.id, nodeName: node.name, result: "failed", msg: "naive node requires profile context" };
        }
        const users = buildNaiveUsers(
          naiveContext.storage,
          naiveContext.storage.listUsers(naiveContext.profileName, naiveContext.ownerId),
        );
        const res = await syncNaiveNode(node, users);
        return {
          nodeId: node.id,
          nodeName: node.name,
          result: res.error ? "failed" : "added",
          msg: res.error,
        };
      }

      try {
        const res = await fetch(`${node.url}/sync-user`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${node.secret}`,
          },
          body: JSON.stringify({ email, uuid, inboundId: node.inboundId, onConflict }),
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        const data = (await res.json()) as { result: string; msg?: string };
        return { nodeId: node.id, nodeName: node.name, result: data.result, msg: data.msg };
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
  naiveContext?: { storage: Storage; profileName: string; ownerId: number },
) {
  return Promise.allSettled(
    nodes.map(async (node) => {
      // The user row is already gone from storage by now, so re-pushing the
      // current list is exactly "delete" for a declarative backend.
      if (node.type === "naive") {
        if (!naiveContext) {
          return { nodeId: node.id, nodeName: node.name, result: "failed", msg: "naive node requires profile context" };
        }
        const users = buildNaiveUsers(
          naiveContext.storage,
          naiveContext.storage.listUsers(naiveContext.profileName, naiveContext.ownerId),
        );
        const res = await syncNaiveNode(node, users);
        return {
          nodeId: node.id,
          nodeName: node.name,
          result: res.error ? "failed" : "deleted",
          msg: res.error,
        };
      }

      try {
        const res = await fetch(`${node.url}/delete-user`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${node.secret}`,
          },
          body: JSON.stringify({ email }),
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        const data = (await res.json()) as { result: string; msg?: string };
        return { nodeId: node.id, nodeName: node.name, result: data.result, msg: data.msg };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { nodeId: node.id, nodeName: node.name, result: "failed", msg };
      }
    }),
  );
}

// Extracts profileId and the sub-path under /profiles/:profileId
function extractProfileRoute(pathname: string): { profileId: string; subPath: string } | null {
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
      response.headers.set("Retry-After", String(loginStatus.retryAfterSeconds));
      return response;
    }

    const adminUserId = await verifyAdminCredentials(parsed.username, parsed.password, storage);

    if (adminUserId === null) {
      const failedAttempt = loginRateLimiter.recordFailure(clientIp, parsed.username);
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
        { ok: true, username: adminUserRecord.username, isPrimary: adminUserRecord.isPrimary },
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
      jsonResponse({ username: adminUser.username, isPrimary: adminUser.isPrimary }),
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
    return noStoreResponse(jsonResponse({ adminUsers: storage.listAdminUsers() }));
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
      const message = error instanceof Error ? error.message : "Failed to create admin user.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(jsonResponse({ adminUsers: storage.listAdminUsers() }, { status: 201 }));
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
      return adminErrorResponse(403, "Primary admin credentials are managed via environment variables.");
    }

    const parsed = await parseJson(req, updateAccountSchema);
    if (parsed instanceof Response) return noStoreResponse(parsed);

    if (parsed.newPassword !== undefined) {
      const match = await Bun.password.verify(parsed.currentPassword!, adminUser.passwordHash);
      if (!match) return adminErrorResponse(400, "Current password is incorrect.");
    }

    const updates: { username?: string; passwordHash?: string } = {};
    if (parsed.username !== undefined) updates.username = parsed.username;
    if (parsed.newPassword !== undefined) updates.passwordHash = await Bun.password.hash(parsed.newPassword);

    try {
      storage.updateAdminUser(adminUserId, updates);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update account.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Profile list and create
  if (adminPathname === "/profiles" && req.method === "GET") {
    return noStoreResponse(jsonResponse({ profiles: storage.listProfiles(adminUserId) }));
  }

  if (adminPathname === "/profiles" && req.method === "POST") {
    const parsed = await parseJson(req, createProfileSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      storage.createProfile(parsed.name, adminUserId, Date.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create profile.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ profiles: storage.listProfiles(adminUserId) }, { status: 201 }),
    );
  }

  // Node routes (scoped by owner)
  if (adminPathname === "/nodes" && req.method === "GET") {
    return noStoreResponse(jsonResponse({ nodes: mapNodes(storage, adminUserId) }));
  }

  if (adminPathname === "/nodes" && req.method === "POST") {
    const parsed = await parseJson(req, createNodeSchema);
    if (parsed instanceof Response) return noStoreResponse(parsed);

    let node;
    try {
      node = storage.addNode(parsed.name, parsed.url, parsed.secret, parsed.inboundId, adminUserId, Date.now(), parsed.type);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add node.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ nodes: mapNodes(storage, adminUserId), node: { id: node.id } }, { status: 201 }),
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
          return adminErrorResponse(400, "inboundId >= 1 is required for xui nodes");
        }
      }

      const updated = storage.updateNode(nodeId, adminUserId, parsed);
      if (!updated) return adminErrorResponse(404, `Unknown node: ${nodeId}`);

      return noStoreResponse(jsonResponse({ nodes: mapNodes(storage, adminUserId) }));
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
        };
        return noStoreResponse(
          jsonResponse({ ok: data.ok === true, version: data.version, commit: data.commit, date: data.date, xui: data.xui, caddy: data.caddy }),
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
      return adminErrorResponse(400, error instanceof Error ? error.message : "Invalid format.");
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

      const renamed = storage.renameProfile(profileId, parsed.name, adminUserId);
      if (!renamed) {
        return adminErrorResponse(404, `Unknown profile: ${profileId}`);
      }

      return noStoreResponse(jsonResponse({ profiles: storage.listProfiles(adminUserId) }));
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
      return adminErrorResponse(400, error instanceof Error ? error.message : "Invalid format.");
    }

    if (parsed.kind === "multi-profile") {
      return adminErrorResponse(400, "Multi-profile dumps must be imported via POST /import.");
    }

    if (parsed.kind === "single-profile") {
      storage.mergeProfileFromFullDump(profileId, parsed.data, adminUserId);
    } else {
      storage.mergeProfileFromLegacyConfig(profileId, parsed.data, subLinkSecret, adminUserId);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Users
  if (subPath === "/users" && req.method === "GET") {
    return noStoreResponse(
      jsonResponse({ users: mapUsers(storage, profileId, adminUserId, baseUrl) }),
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
      const message = error instanceof Error ? error.message : "Failed to add user.";
      return adminErrorResponse(400, message);
    }

    const nodes = storage.listNodesForProfile(profileId, adminUserId);
    const syncSettled = await syncUserToNodes(nodes, parsed.clientName, parsed.userUuid, "skip", {
      storage,
      profileName: profileId,
      ownerId: adminUserId,
    });
    const syncResults = syncSettled.map((r) =>
      r.status === "fulfilled" ? r.value : { result: "failed", msg: String(r.reason) },
    );

    return noStoreResponse(
      jsonResponse(
        { users: mapUsers(storage, profileId, adminUserId, baseUrl), syncResults },
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

    const syncSettled = await syncUserToNodes(nodes, user.clientName, user.userUuid, "overwrite", {
      storage,
      profileName: profileId,
      ownerId: adminUserId,
    });
    const syncResults = syncSettled.map((r) =>
      r.status === "fulfilled" ? r.value : { result: "failed", msg: String(r.reason) },
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
        const renamed = storage.renameUser(profileId, userPathName, parsed.clientName, adminUserId);
        if (!renamed) {
          return adminErrorResponse(404, `Unknown client: ${userPathName}`);
        }
      }

      if (parsed.userUuid !== undefined) {
        const targetName = parsed.clientName ?? userPathName;
        const updated = storage.setUserUuid(profileId, targetName, parsed.userUuid, adminUserId);
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
      jsonResponse({ users: mapUsers(storage, profileId, adminUserId, baseUrl) }),
    );
  }

  if (userPathName && req.method === "DELETE") {
    let nodeIds: number[] = [];
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const body = (await req.json()) as { nodeIds?: unknown };
        if (Array.isArray(body.nodeIds)) {
          nodeIds = body.nodeIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
        }
      } catch {}
    }

    const removed = storage.removeUser(profileId, userPathName, adminUserId);
    if (!removed) {
      return adminErrorResponse(404, `Unknown client: ${userPathName}`);
    }

    if (nodeIds.length > 0) {
      const profileNodes = storage.listNodesForProfile(profileId, adminUserId);
      const selectedNodes = profileNodes.filter((n) => nodeIds.includes(n.id));
      const settled = await deleteUserFromNodes(selectedNodes, userPathName, {
        storage,
        profileName: profileId,
        ownerId: adminUserId,
      });
      const syncResults = settled.map((r) =>
        r.status === "fulfilled" ? r.value : { result: "failed", msg: String(r.reason) },
      );
      return noStoreResponse(jsonResponse({ syncResults }));
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Servers
  if (subPath === "/servers" && req.method === "GET") {
    return noStoreResponse(jsonResponse({ servers: mapServers(storage, profileId, adminUserId) }));
  }

  if (subPath === "/servers" && req.method === "POST") {
    const parsed = await parseJson(req, createServerSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    if (parsed.nodeId) {
      const existing = storage.listServerRecords(profileId, adminUserId);
      const conflict = existing.find((s) => s.nodeId === parsed.nodeId);
      if (conflict) return adminErrorResponse(400, `Node is already assigned to server "${conflict.name}"`);
    }

    try {
      storage.addServer(profileId, parsed.name, parsed.template, Date.now(), adminUserId, parsed.nodeId ?? null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add server.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ servers: mapServers(storage, profileId, adminUserId) }, { status: 201 }),
    );
  }

  if (subPath === "/servers/order" && req.method === "PUT") {
    const parsed = await parseJson(req, reorderServersSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    storage.reorderServers(profileId, parsed.order, adminUserId);
    return noStoreResponse(jsonResponse({ servers: mapServers(storage, profileId, adminUserId) }));
  }

  if (subPath === "/servers/ping" && req.method === "POST") {
    const parsed = await parseJson(req, pingServersSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    const strategy = parsed.strategy ?? "all";
    let records = storage.listServerRecords(profileId, adminUserId);
    const serverSet = parsed.servers && parsed.servers.length > 0 ? new Set(parsed.servers) : null;
    const serverExceptSet = parsed.serversExcept && parsed.serversExcept.length > 0 ? new Set(parsed.serversExcept) : null;
    if (serverSet) records = records.filter((s) => serverSet.has(s.name));
    else if (serverExceptSet) records = records.filter((s) => !serverExceptSet.has(s.name));

    if (strategy !== "icmp") {
      const httpReq = checkHttpPingRequirements();
      if (!httpReq.ok) {
        return adminErrorResponse(422, `HTTP ping unavailable: ${httpReq.error}`);
      }
    }

    const servers = records.map((s) => ({ name: s.name, template: s.template }));
    let userRecords = storage.listUsers(profileId, adminUserId);
    const userSet = parsed.users && parsed.users.length > 0 ? new Set(parsed.users) : null;
    const userExceptSet = parsed.usersExcept && parsed.usersExcept.length > 0 ? new Set(parsed.usersExcept) : null;
    if (userSet) userRecords = userRecords.filter((u) => userSet.has(u.clientName));
    else if (userExceptSet) userRecords = userRecords.filter((u) => !userExceptSet.has(u.clientName));
    const users = userRecords.map((u) => ({ clientName: u.clientName, userUuid: u.userUuid }));

    const [icmp, http] = await Promise.all([
      strategy !== "http" ? pingAllIcmp(servers) : Promise.resolve(null),
      strategy !== "icmp" ? pingAllHttp(servers, users) : Promise.resolve(null),
    ]);

    return noStoreResponse(jsonResponse({ icmp, http }));
  }

  const serverSyncMatch = subPath.match(/^\/servers\/([^/]+)\/sync-users$/);
  if (serverSyncMatch && req.method === "POST") {
    const serverName = decodeURIComponent(serverSyncMatch[1]!);
    const serverRecord = storage.listServerRecords(profileId, adminUserId).find((s) => s.name === serverName);
    if (!serverRecord) return adminErrorResponse(404, `Unknown server: ${serverName}`);
    if (!serverRecord.nodeId) return adminErrorResponse(400, `Server "${serverName}" has no node assigned`);

    const node = storage.getNode(serverRecord.nodeId, adminUserId);
    if (!node) return adminErrorResponse(404, `Node not found`);

    // Naive nodes take the whole list in one declarative push — per-user
    // conflict strategies don't apply, so skip that machinery entirely.
    if (node.type === "naive") {
      const naiveUsers = buildNaiveUsers(storage, storage.listUsers(profileId, adminUserId));
      const res = await syncNaiveNode(node, naiveUsers);
      if (res.error) return adminErrorResponse(502, res.error);
      return noStoreResponse(
        jsonResponse({
          synced: res.synced,
          failed: 0,
          results: naiveUsers.map((u) => ({ clientName: u.user, result: "added" })),
        }),
      );
    }

    const parsed = await parseJson(req, syncUsersSchema);
    if (parsed instanceof Response) return noStoreResponse(parsed);

    const users = storage.listUsers(profileId, adminUserId);

    if (parsed.onConflict === "safe") {
      try {
        const checkRes = await fetch(`${node.url}/check-conflicts`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${node.secret}` },
          body: JSON.stringify({ emails: users.map((u) => u.clientName) }),
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        const checkData = (await checkRes.json()) as { conflicts?: string[]; error?: string };
        if (!checkRes.ok) return adminErrorResponse(502, checkData.error ?? "Failed to check conflicts on node");
        const conflicts = checkData.conflicts ?? [];
        if (conflicts.length > 0) return noStoreResponse(jsonResponse({ conflicts }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return adminErrorResponse(502, `Failed to reach node for conflict check: ${msg}`);
      }
    }

    const strategy = parsed.onConflict === "safe" ? "skip" : parsed.onConflict;
    const settled = await Promise.allSettled(
      users.map((u) => syncUserToNodes([node], u.clientName, u.userUuid, strategy, { storage, profileName: profileId, ownerId: adminUserId })),
    );

    const results: { clientName: string; result: string; msg?: string }[] = [];
    let synced = 0;
    let failed = 0;
    for (let i = 0; i < settled.length; i++) {
      const user = users[i]!;
      const s = settled[i]!;
      if (s.status === "fulfilled") {
        const nodeResult = s.value[0];
        const r = nodeResult?.status === "fulfilled" ? nodeResult.value : { result: "failed", msg: "unexpected" };
        if (r.result === "failed") failed++; else synced++;
        results.push({ clientName: user.clientName, result: r.result, msg: r.msg });
      } else {
        failed++;
        results.push({ clientName: user.clientName, result: "failed", msg: s.reason instanceof Error ? s.reason.message : String(s.reason) });
      }
    }

    return noStoreResponse(jsonResponse({ synced, failed, results }));
  }

  const serverPathName = getServerSubPath(subPath);
  if (serverPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateServerSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      if (parsed.name !== undefined) {
        const renamed = storage.renameServer(profileId, serverPathName, parsed.name, adminUserId);
        if (!renamed) {
          return adminErrorResponse(404, `Unknown server name: ${serverPathName}`);
        }
      }

      if (parsed.template !== undefined) {
        const targetName = parsed.name ?? serverPathName;
        const updated = storage.setServerUrl(profileId, targetName, parsed.template, adminUserId);
        if (!updated) {
          return adminErrorResponse(404, `Unknown server name: ${targetName}`);
        }
      }

      if (parsed.nodeId !== undefined) {
        const targetName = parsed.name ?? serverPathName;
        if (parsed.nodeId !== null) {
          const existing = storage.listServerRecords(profileId, adminUserId);
          const conflict = existing.find((s) => s.nodeId === parsed.nodeId && s.name !== targetName);
          if (conflict) return adminErrorResponse(400, `Node is already assigned to server "${conflict.name}"`);
        }
        const updated = storage.setServerNode(profileId, targetName, parsed.nodeId, adminUserId);
        if (!updated) {
          return adminErrorResponse(404, `Unknown server name: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update server.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(jsonResponse({ servers: mapServers(storage, profileId, adminUserId) }));
  }

  if (serverPathName && req.method === "DELETE") {
    const removed = storage.removeServer(profileId, serverPathName, adminUserId);
    if (!removed) {
      return adminErrorResponse(404, `Unknown server name: ${serverPathName}`);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  return adminErrorResponse(404, "Not found.");
}
