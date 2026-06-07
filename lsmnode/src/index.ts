import { XUIService } from "../../src/3x-ui";

const REPO_DIR = new URL("../..", import.meta.url).pathname;

function getVersionInfo(): { commit: string; date: string } | null {
  try {
    const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_DIR });
    const date = Bun.spawnSync(["git", "log", "-1", "--format=%cd", "--date=short"], { cwd: REPO_DIR });
    if (commit.exitCode !== 0 || date.exitCode !== 0) return null;
    return {
      commit: new TextDecoder().decode(commit.stdout).trim(),
      date: new TextDecoder().decode(date.stdout).trim(),
    };
  } catch {
    return null;
  }
}

const version = getVersionInfo();

const PORT = parseInt(process.env.PORT ?? "9000", 10);
const SHARED_SECRET = process.env.SHARED_SECRET;
const XUI_HOST = process.env.XUI_HOST;
const XUI_USER = process.env.XUI_USER;
const XUI_PASSWORD = process.env.XUI_PASSWORD;

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");
if (!XUI_HOST) throw new Error("XUI_HOST is required");
if (!XUI_USER) throw new Error("XUI_USER is required");
if (!XUI_PASSWORD) throw new Error("XUI_PASSWORD is required");

const xui = new XUIService({ host: XUI_HOST, user: XUI_USER, password: XUI_PASSWORD });

type SyncResult = "added" | "skipped" | "overwritten" | "kept-both" | "deleted" | "not_found" | "failed";
type OnConflict = "skip" | "overwrite" | "keep-both";

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function checkAuth(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  return auth === `Bearer ${SHARED_SECRET}`;
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    if (!checkAuth(req)) return unauthorized();

    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ ok: true, ...version });
    }

    if (url.pathname === "/sync-user" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      if (typeof body !== "object" || body === null) {
        return Response.json({ error: "Invalid body" }, { status: 400 });
      }

      const { email, uuid, inboundId, onConflict } = body as Record<string, unknown>;

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
        const result: SyncResult = await xui.syncUser(inboundId, email, uuid, conflict);
        return Response.json({ result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`sync-user failed for ${email}:`, msg);
        return Response.json({ result: "failed", msg }, { status: 500 });
      }
    }

    if (url.pathname === "/delete-user" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      if (typeof body !== "object" || body === null) {
        return Response.json({ error: "Invalid body" }, { status: 400 });
      }

      const { email } = body as Record<string, unknown>;

      if (typeof email !== "string" || !email) {
        return Response.json({ error: "email is required" }, { status: 400 });
      }

      try {
        const result: SyncResult = await xui.deleteUser(email);
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

console.log(`lsm-node listening on ${server.hostname}:${server.port}`);
