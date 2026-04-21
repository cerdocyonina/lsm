import { z } from "zod";
import {
  clearSessionCookie,
  createSessionCookie,
  isAdminAuthenticated,
  readSession,
  verifyAdminCredentials,
} from "./admin-auth";
import type { LoginRateLimiter } from "./admin-rate-limit";
import { checkHttpPingRequirements, pingAllHttp, pingAllIcmp } from "./ping";
import type { ProfileRecord, Storage } from "./storage";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createProfileSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/, "Profile ID must be lowercase alphanumeric, hyphens, or underscores"),
  name: z.string().min(1),
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
  })
  .refine((input) => input.name !== undefined || input.template !== undefined, {
    message: "Provide at least one server field to update.",
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

function requireAuth(req: Request): Response | null {
  if (isAdminAuthenticated(req)) {
    return null;
  }

  return adminErrorResponse(401, "Unauthorized.");
}

function requireProfile(storage: Storage, profileId: string): ProfileRecord | Response {
  const profile = storage.getProfile(profileId);
  if (!profile) {
    return adminErrorResponse(404, `Unknown profile: ${profileId}`);
  }
  return profile;
}

function mapUsers(storage: Storage, profileId: string, baseUrl: string) {
  return storage.listUsers(profileId).map((user) => ({
    clientName: user.clientName,
    userUuid: user.userUuid,
    subscriptionToken: user.subscriptionToken,
    subscriptionUrl: createSubscriptionUrl(baseUrl, user.subscriptionToken),
    createdAt: user.createdAt,
  }));
}

function mapServers(storage: Storage, profileId: string) {
  return storage.listServerRecords(profileId).map((server) => ({
    name: server.name,
    sortOrder: server.sortOrder,
    template: server.template,
    createdAt: server.createdAt,
  }));
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

    if (!verifyAdminCredentials(parsed.username, parsed.password)) {
      const failedAttempt = loginRateLimiter.recordFailure(clientIp, parsed.username);
      const statusCode = failedAttempt.allowed ? 401 : 429;
      const response = noStoreResponse(
        errorResponse(
          statusCode,
          failedAttempt.allowed
            ? "Invalid admin credentials."
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

    return noStoreResponse(
      jsonResponse(
        { ok: true, username: parsed.username },
        {
          headers: {
            "Set-Cookie": createSessionCookie(),
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
    const unauthorized = requireAuth(req);
    if (unauthorized) {
      return unauthorized;
    }

    const session = readSession(req);
    if (!session) {
      return adminErrorResponse(401, "Unauthorized.");
    }

    return noStoreResponse(jsonResponse({ username: session.username }));
  }

  const unauthorized = requireAuth(req);
  if (unauthorized) {
    return unauthorized;
  }

  // Profile list and create
  if (adminPathname === "/profiles" && req.method === "GET") {
    return noStoreResponse(jsonResponse({ profiles: storage.listProfiles() }));
  }

  if (adminPathname === "/profiles" && req.method === "POST") {
    const parsed = await parseJson(req, createProfileSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      storage.createProfile(parsed.id, parsed.name, Date.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create profile.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ profiles: storage.listProfiles() }, { status: 201 }),
    );
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

      const renamed = storage.renameProfile(profileId, parsed.name);
      if (!renamed) {
        return adminErrorResponse(404, `Unknown profile: ${profileId}`);
      }

      return noStoreResponse(jsonResponse({ profiles: storage.listProfiles() }));
    }

    if (req.method === "DELETE") {
      const deleted = storage.deleteProfile(profileId);
      if (!deleted) {
        return adminErrorResponse(404, `Unknown profile: ${profileId}`);
      }

      return noStoreResponse(new Response(null, { status: 204 }));
    }

    return adminErrorResponse(405, "Method not allowed.");
  }

  // All sub-routes require the profile to exist
  const profileOrError = requireProfile(storage, profileId);
  if (profileOrError instanceof Response) {
    return profileOrError;
  }

  // Users
  if (subPath === "/users" && req.method === "GET") {
    return noStoreResponse(jsonResponse({ users: mapUsers(storage, profileId, baseUrl) }));
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
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add user.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ users: mapUsers(storage, profileId, baseUrl) }, { status: 201 }),
    );
  }

  const userPathName = getUserSubPath(subPath);
  if (userPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateUserSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      if (parsed.clientName !== undefined) {
        const renamed = storage.renameUser(profileId, userPathName, parsed.clientName);
        if (!renamed) {
          return adminErrorResponse(404, `Unknown client: ${userPathName}`);
        }
      }

      if (parsed.userUuid !== undefined) {
        const targetName = parsed.clientName ?? userPathName;
        const updated = storage.setUserUuid(profileId, targetName, parsed.userUuid);
        if (!updated) {
          return adminErrorResponse(404, `Unknown client: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update user.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(jsonResponse({ users: mapUsers(storage, profileId, baseUrl) }));
  }

  if (userPathName && req.method === "DELETE") {
    const removed = storage.removeUser(profileId, userPathName);
    if (!removed) {
      return adminErrorResponse(404, `Unknown client: ${userPathName}`);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  // Servers
  if (subPath === "/servers" && req.method === "GET") {
    return noStoreResponse(jsonResponse({ servers: mapServers(storage, profileId) }));
  }

  if (subPath === "/servers" && req.method === "POST") {
    const parsed = await parseJson(req, createServerSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      storage.addServer(profileId, parsed.name, parsed.template, Date.now());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add server.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ servers: mapServers(storage, profileId) }, { status: 201 }),
    );
  }

  if (subPath === "/servers/order" && req.method === "PUT") {
    const parsed = await parseJson(req, reorderServersSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    storage.reorderServers(profileId, parsed.order);
    return noStoreResponse(jsonResponse({ servers: mapServers(storage, profileId) }));
  }

  if (subPath === "/servers/ping" && req.method === "POST") {
    const parsed = await parseJson(req, pingServersSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    const strategy = parsed.strategy ?? "all";
    let records = storage.listServerRecords(profileId);
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
    let userRecords = storage.listUsers(profileId);
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

  const serverPathName = getServerSubPath(subPath);
  if (serverPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateServerSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      if (parsed.name !== undefined) {
        const renamed = storage.renameServer(profileId, serverPathName, parsed.name);
        if (!renamed) {
          return adminErrorResponse(404, `Unknown server name: ${serverPathName}`);
        }
      }

      if (parsed.template !== undefined) {
        const targetName = parsed.name ?? serverPathName;
        const updated = storage.setServerUrl(profileId, targetName, parsed.template);
        if (!updated) {
          return adminErrorResponse(404, `Unknown server name: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update server.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(jsonResponse({ servers: mapServers(storage, profileId) }));
  }

  if (serverPathName && req.method === "DELETE") {
    const removed = storage.removeServer(profileId, serverPathName);
    if (!removed) {
      return adminErrorResponse(404, `Unknown server name: ${serverPathName}`);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  return adminErrorResponse(404, "Not found.");
}
