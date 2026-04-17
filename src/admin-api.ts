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
import type { Storage } from "./storage";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
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
  names: z.array(z.string().min(1)).optional(),
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

function getUserPathName(pathname: string): string | null {
  const match = pathname.match(/^\/users\/([^/]+)$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function getServerPathName(pathname: string): string | null {
  const match = pathname.match(/^\/servers\/([^/]+)$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function requireAuth(req: Request): Response | null {
  if (isAdminAuthenticated(req)) {
    return null;
  }

  return adminErrorResponse(401, "Unauthorized.");
}

function mapUsers(storage: Storage, baseUrl: string) {
  return storage.listUsers().map((user) => ({
    clientName: user.clientName,
    userUuid: user.userUuid,
    subscriptionToken: user.subscriptionToken,
    subscriptionUrl: createSubscriptionUrl(baseUrl, user.subscriptionToken),
    createdAt: user.createdAt,
  }));
}

function mapServers(storage: Storage) {
  return storage.listServerRecords().map((server) => ({
    name: server.name,
    sortOrder: server.sortOrder,
    template: server.template,
    createdAt: server.createdAt,
  }));
}

export async function handleAdminApiRequest(
  req: Request,
  pathname: string,
  storage: Storage,
  createSubscriptionToken: (name: string) => string,
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

  if (adminPathname === "/users" && req.method === "GET") {
    return noStoreResponse(jsonResponse({ users: mapUsers(storage, baseUrl) }));
  }

  if (adminPathname === "/users" && req.method === "POST") {
    const parsed = await parseJson(req, createUserSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      storage.addUser(
        parsed.clientName,
        createSubscriptionToken(parsed.clientName),
        parsed.userUuid,
        Date.now(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add user.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ users: mapUsers(storage, baseUrl) }, { status: 201 }),
    );
  }

  const userPathName = getUserPathName(adminPathname);
  if (userPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateUserSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      if (parsed.clientName !== undefined) {
        const renamed = storage.renameUser(userPathName, parsed.clientName);
        if (!renamed) {
          return adminErrorResponse(404, `Unknown client: ${userPathName}`);
        }
      }

      if (parsed.userUuid !== undefined) {
        const targetName = parsed.clientName ?? userPathName;
        const updated = storage.setUserUuid(targetName, parsed.userUuid);
        if (!updated) {
          return adminErrorResponse(404, `Unknown client: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update user.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(jsonResponse({ users: mapUsers(storage, baseUrl) }));
  }

  if (userPathName && req.method === "DELETE") {
    const removed = storage.removeUser(userPathName);
    if (!removed) {
      return adminErrorResponse(404, `Unknown client: ${userPathName}`);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  if (adminPathname === "/servers" && req.method === "GET") {
    return noStoreResponse(jsonResponse({ servers: mapServers(storage) }));
  }

  if (adminPathname === "/servers" && req.method === "POST") {
    const parsed = await parseJson(req, createServerSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      storage.addServer(parsed.name, parsed.template, Date.now());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add server.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(
      jsonResponse({ servers: mapServers(storage) }, { status: 201 }),
    );
  }

  if (adminPathname === "/servers/order" && req.method === "PUT") {
    const parsed = await parseJson(req, reorderServersSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    storage.reorderServers(parsed.order);
    return noStoreResponse(jsonResponse({ servers: mapServers(storage) }));
  }

  const serverPathName = getServerPathName(adminPathname);
  if (serverPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateServerSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    try {
      if (parsed.name !== undefined) {
        const renamed = storage.renameServer(serverPathName, parsed.name);
        if (!renamed) {
          return adminErrorResponse(404, `Unknown server name: ${serverPathName}`);
        }
      }

      if (parsed.template !== undefined) {
        const targetName = parsed.name ?? serverPathName;
        const updated = storage.setServerUrl(targetName, parsed.template);
        if (!updated) {
          return adminErrorResponse(404, `Unknown server name: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update server.";
      return adminErrorResponse(400, message);
    }

    return noStoreResponse(jsonResponse({ servers: mapServers(storage) }));
  }

  if (serverPathName && req.method === "DELETE") {
    const removed = storage.removeServer(serverPathName);
    if (!removed) {
      return adminErrorResponse(404, `Unknown server name: ${serverPathName}`);
    }

    return noStoreResponse(new Response(null, { status: 204 }));
  }

  if (adminPathname === "/servers/ping" && req.method === "POST") {
    const parsed = await parseJson(req, pingServersSchema);
    if (parsed instanceof Response) {
      return noStoreResponse(parsed);
    }

    const strategy = parsed.strategy ?? "all";
    let records = storage.listServerRecords();
    if (parsed.names && parsed.names.length > 0) {
      const nameSet = new Set(parsed.names);
      records = records.filter((s) => nameSet.has(s.name));
    }

    if (strategy !== "icmp") {
      const httpReq = checkHttpPingRequirements();
      if (!httpReq.ok) {
        return adminErrorResponse(422, `HTTP ping unavailable: ${httpReq.error}`);
      }
    }

    const servers = records.map((s) => ({ name: s.name, template: s.template }));
    const users = storage.listUsers().map((u) => ({ clientName: u.clientName, userUuid: u.userUuid }));

    const [icmp, http] = await Promise.all([
      strategy !== "http" ? pingAllIcmp(servers) : Promise.resolve(null),
      strategy !== "icmp" ? pingAllHttp(servers, users) : Promise.resolve(null),
    ]);

    return noStoreResponse(jsonResponse({ icmp, http }));
  }

  return adminErrorResponse(404, "Not found.");
}
