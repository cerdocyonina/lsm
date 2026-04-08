import { z } from "zod";
import {
  clearSessionCookie,
  createSessionCookie,
  isAdminAuthenticated,
  readSession,
  verifyAdminCredentials,
} from "./admin-auth";
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

function getOrigin(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function createSubscriptionUrl(req: Request, subscriptionToken: string): string {
  return `${getOrigin(req)}/${subscriptionToken}`;
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

  return errorResponse(401, "Unauthorized.");
}

function mapUsers(req: Request, storage: Storage) {
  return storage.listUsers().map((user) => ({
    clientName: user.clientName,
    userUuid: user.userUuid,
    subscriptionToken: user.subscriptionToken,
    subscriptionUrl: createSubscriptionUrl(req, user.subscriptionToken),
  }));
}

function mapServers(storage: Storage) {
  return storage.listServerRecords().map((server) => ({
    name: server.name,
    sortOrder: server.sortOrder,
    template: server.template,
  }));
}

export async function handleAdminApiRequest(
  req: Request,
  pathname: string,
  storage: Storage,
  createSubscriptionToken: (name: string) => string,
  adminBasePath: string,
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
      return parsed;
    }

    if (!verifyAdminCredentials(parsed.username, parsed.password)) {
      return errorResponse(401, "Invalid admin credentials.");
    }

    return jsonResponse(
      { ok: true, username: parsed.username },
      {
        headers: {
          "Set-Cookie": createSessionCookie(),
        },
      },
    );
  }

  if (adminPathname === "/auth/logout" && req.method === "POST") {
    return new Response(null, {
      status: 204,
      headers: {
        "Set-Cookie": clearSessionCookie(),
      },
    });
  }

  const unauthorized = requireAuth(req);
  if (unauthorized) {
    return unauthorized;
  }

  if (adminPathname === "/session" && req.method === "GET") {
    const session = readSession(req);
    if (!session) {
      return errorResponse(401, "Unauthorized.");
    }

    return jsonResponse({ username: session.username });
  }

  if (adminPathname === "/users" && req.method === "GET") {
    return jsonResponse({ users: mapUsers(req, storage) });
  }

  if (adminPathname === "/users" && req.method === "POST") {
    const parsed = await parseJson(req, createUserSchema);
    if (parsed instanceof Response) {
      return parsed;
    }

    try {
      storage.addUser(
        parsed.clientName,
        createSubscriptionToken(parsed.clientName),
        parsed.userUuid,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add user.";
      return errorResponse(400, message);
    }

    return jsonResponse({ users: mapUsers(req, storage) }, { status: 201 });
  }

  const userPathName = getUserPathName(adminPathname);
  if (userPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateUserSchema);
    if (parsed instanceof Response) {
      return parsed;
    }

    try {
      if (parsed.clientName !== undefined) {
        const renamed = storage.renameUser(userPathName, parsed.clientName);
        if (!renamed) {
          return errorResponse(404, `Unknown client: ${userPathName}`);
        }
      }

      if (parsed.userUuid !== undefined) {
        const targetName = parsed.clientName ?? userPathName;
        const updated = storage.setUserUuid(targetName, parsed.userUuid);
        if (!updated) {
          return errorResponse(404, `Unknown client: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update user.";
      return errorResponse(400, message);
    }

    return jsonResponse({ users: mapUsers(req, storage) });
  }

  if (userPathName && req.method === "DELETE") {
    const removed = storage.removeUser(userPathName);
    if (!removed) {
      return errorResponse(404, `Unknown client: ${userPathName}`);
    }

    return new Response(null, { status: 204 });
  }

  if (adminPathname === "/servers" && req.method === "GET") {
    return jsonResponse({ servers: mapServers(storage) });
  }

  if (adminPathname === "/servers" && req.method === "POST") {
    const parsed = await parseJson(req, createServerSchema);
    if (parsed instanceof Response) {
      return parsed;
    }

    try {
      storage.addServer(parsed.name, parsed.template);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add server.";
      return errorResponse(400, message);
    }

    return jsonResponse({ servers: mapServers(storage) }, { status: 201 });
  }

  const serverPathName = getServerPathName(adminPathname);
  if (serverPathName && req.method === "PATCH") {
    const parsed = await parseJson(req, updateServerSchema);
    if (parsed instanceof Response) {
      return parsed;
    }

    try {
      if (parsed.name !== undefined) {
        const renamed = storage.renameServer(serverPathName, parsed.name);
        if (!renamed) {
          return errorResponse(404, `Unknown server name: ${serverPathName}`);
        }
      }

      if (parsed.template !== undefined) {
        const targetName = parsed.name ?? serverPathName;
        const updated = storage.setServerUrl(targetName, parsed.template);
        if (!updated) {
          return errorResponse(404, `Unknown server name: ${targetName}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update server.";
      return errorResponse(400, message);
    }

    return jsonResponse({ servers: mapServers(storage) });
  }

  if (serverPathName && req.method === "DELETE") {
    const removed = storage.removeServer(serverPathName);
    if (!removed) {
      return errorResponse(404, `Unknown server name: ${serverPathName}`);
    }

    return new Response(null, { status: 204 });
  }

  return errorResponse(404, "Not found.");
}
