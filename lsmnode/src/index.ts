import { version as PKG_VERSION } from "../../package.json";
import type { NaiveUser, NodeBackend, OnConflict, SyncResult } from "./backends/types";
import { buildBackends } from "./config";
import { buildHealthPayload, type VersionInfo } from "./health-payload";

const REPO_DIR = new URL("../..", import.meta.url).pathname;

function getVersionInfo(): VersionInfo {
  try {
    const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_DIR });
    const date = Bun.spawnSync(["git", "log", "-1", "--format=%cd", "--date=short"], { cwd: REPO_DIR });
    if (commit.exitCode !== 0 || date.exitCode !== 0) return { version: PKG_VERSION };
    return {
      version: PKG_VERSION,
      commit: new TextDecoder().decode(commit.stdout).trim(),
      date: new TextDecoder().decode(date.stdout).trim(),
    };
  } catch {
    return { version: PKG_VERSION };
  }
}

const version = getVersionInfo();

const PORT = parseInt(process.env.PORT ?? "9000", 10);
const SHARED_SECRET = process.env.SHARED_SECRET;

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

// Один агент — несколько бэкендов. Мастер адресует бэкенд первым сегментом пути
// (/<name>/sync-users); unprefixed-роуты идут в default (обратная совместимость с
// существующими нодами, которые ходят на голый /sync-users).
const { backends, defaultName } = buildBackends(process.env);

/** По pathname выбираем бэкенд и «действие» без его префикса. */
function resolveBackend(pathname: string): { backend: NodeBackend; action: string } {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length > 0 && backends.has(segments[0]!)) {
    return { backend: backends.get(segments[0]!)!, action: `/${segments.slice(1).join("/")}` };
  }
  return { backend: backends.get(defaultName)!, action: pathname };
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function unsupported(endpoint: string, backend: NodeBackend): Response {
  return Response.json(
    { error: `${endpoint} is not supported by backend kind=${backend.kind}` },
    { status: 400 },
  );
}

function checkAuth(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  return auth === `Bearer ${SHARED_SECRET}`;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  return body as Record<string, unknown>;
}

function parseNaiveUsers(value: unknown): NaiveUser[] | null {
  if (!Array.isArray(value)) return null;
  const users: NaiveUser[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { user, pass } = entry as Record<string, unknown>;
    if (typeof user !== "string" || !user) return null;
    if (typeof pass !== "string" || !pass) return null;
    users.push({ user, pass });
  }
  return users;
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    if (!checkAuth(req)) return unauthorized();

    const url = new URL(req.url);
    const { backend, action } = resolveBackend(url.pathname);

    if (action === "/health" && req.method === "GET") {
      const status = await backend.health(3000);
      return Response.json(buildHealthPayload(backend.kind, status, version));
    }

    // --- naive / shadowsocks: declarative full-list sync ---------------------
    if (action === "/sync-users" && req.method === "POST") {
      if (!backend.syncUsers) return unsupported("/sync-users", backend);

      const body = await readJsonObject(req);
      if (body instanceof Response) return body;

      const users = parseNaiveUsers(body.users);
      if (!users) {
        return Response.json(
          { error: "users must be an array of { user: string, pass: string }" },
          { status: 400 },
        );
      }

      try {
        return Response.json(await backend.syncUsers(users));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("sync-users failed:", msg);
        return Response.json({ error: msg }, { status: 400 });
      }
    }

    // --- xui: per-user sync ---------------------------------------------------
    if (action === "/sync-user" && req.method === "POST") {
      if (!backend.syncUser) return unsupported("/sync-user", backend);

      const body = await readJsonObject(req);
      if (body instanceof Response) return body;

      const { email, uuid, inboundId, onConflict } = body;

      if (typeof email !== "string" || !email) {
        return Response.json({ error: "email is required" }, { status: 400 });
      }
      if (typeof uuid !== "string" || !uuid) {
        return Response.json({ error: "uuid is required" }, { status: 400 });
      }
      if (typeof inboundId !== "number") {
        return Response.json({ error: "inboundId must be a number" }, { status: 400 });
      }

      const conflict = (onConflict as OnConflict | undefined) ?? "skip";
      if (!["skip", "overwrite", "keep-both"].includes(conflict)) {
        return Response.json(
          { error: "onConflict must be skip, overwrite, or keep-both" },
          { status: 400 },
        );
      }

      try {
        const result: SyncResult = await backend.syncUser(inboundId, email, uuid, conflict);
        return Response.json({ result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`sync-user failed for ${email}:`, msg);
        return Response.json({ result: "failed", msg }, { status: 500 });
      }
    }

    if (action === "/check-conflicts" && req.method === "POST") {
      if (!backend.checkConflicts) return unsupported("/check-conflicts", backend);

      const body = await readJsonObject(req);
      if (body instanceof Response) return body;

      const { emails } = body;
      if (!Array.isArray(emails) || emails.some((e) => typeof e !== "string")) {
        return Response.json({ error: "emails must be an array of strings" }, { status: 400 });
      }

      try {
        const conflicts = await backend.checkConflicts(emails as string[]);
        return Response.json({ conflicts });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("check-conflicts failed:", msg);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    if (action === "/delete-user" && req.method === "POST") {
      if (!backend.deleteUser) return unsupported("/delete-user", backend);

      const body = await readJsonObject(req);
      if (body instanceof Response) return body;

      const { email } = body;
      if (typeof email !== "string" || !email) {
        return Response.json({ error: "email is required" }, { status: 400 });
      }

      try {
        const result: SyncResult = await backend.deleteUser(email);
        return Response.json({ result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`delete-user failed for ${email}:`, msg);
        return Response.json({ result: "failed", msg }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

const mounted = [...backends.entries()].map(([name, b]) => `${name}=${b.kind}`).join(", ");
console.log(`lsm-node listening on ${server.hostname}:${server.port} — backends: ${mounted} (default=${defaultName})`);
