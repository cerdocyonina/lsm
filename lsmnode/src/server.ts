import type {
  ClientSyncRequest,
  NaiveUser,
  NodeBackend,
  OnConflict,
  SyncResult,
} from "./backends/types";
import type { BackendRegistry } from "./config";
import { buildHealthPayload, type VersionInfo } from "./health-payload";

/** Injectable HTTP handler: discovery is read-only; legacy backend routes stay compatible. */
export function createAgentHandler(
  { backends, defaultName }: BackendRegistry,
  SHARED_SECRET: string,
  version: VersionInfo,
) {
  const queues = new Map<NodeBackend, Promise<unknown>>();
  async function serialize<T>(
    backend: NodeBackend,
    operation: () => Promise<T>,
  ): Promise<T> {
    const work = (queues.get(backend) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    queues.set(backend, work);
    try {
      return await work;
    } finally {
      if (queues.get(backend) === work) queues.delete(backend);
    }
  }
  /** По pathname выбираем бэкенд и «действие» без его префикса. */
  function resolveBackend(pathname: string): {
    backend: NodeBackend;
    action: string;
  } {
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length > 0 && backends.has(segments[0]!)) {
      return {
        backend: backends.get(segments[0]!)!,
        action: `/${segments.slice(1).join("/")}`,
      };
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

  async function readJsonObject(
    req: Request,
  ): Promise<Record<string, unknown> | Response> {
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

  /** Validates a /sync-clients body; returns an error message on bad input. */
  function parseClientSync(body: Record<string, unknown>): ClientSyncRequest | string {
    const { inboundId, clients, remove, onConflict, dryRun } = body;
    if (typeof inboundId !== "number" || !Number.isInteger(inboundId) || inboundId < 1)
      return "inboundId must be a positive integer";
    const pairs = (value: unknown, label: string) => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) return null;
      for (const e of value) {
        const { email, uuid, legacyEmail } = (e ?? {}) as Record<string, unknown>;
        if (typeof email !== "string" || !email || typeof uuid !== "string" || !uuid) return null;
        if (label === "clients" && legacyEmail !== undefined && typeof legacyEmail !== "string") return null;
      }
      return value as { email: string; uuid: string; legacyEmail?: string }[];
    };
    const c = pairs(clients, "clients");
    const r = pairs(remove, "remove");
    if (!c) return "clients must be an array of { email, uuid, legacyEmail? }";
    if (!r) return "remove must be an array of { email, uuid }";
    const strategy = (onConflict ?? "skip") as OnConflict;
    if (!["skip", "overwrite", "keep-both"].includes(strategy))
      return "onConflict must be skip, overwrite, or keep-both";
    return {
      inboundId,
      clients: c,
      remove: r.map(({ email, uuid }) => ({ email, uuid })),
      onConflict: strategy,
      dryRun: dryRun === true,
    };
  }

  return async function fetch(req: Request): Promise<Response> {
    if (!checkAuth(req)) return unauthorized();

    const url = new URL(req.url);
    if (url.pathname === "/backends" && req.method === "GET") {
      return Response.json({
        ...version,
        default: defaultName,
        backends: [...backends].map(([name, backend]) => ({
          name,
          kind: backend.kind,
          path: `/${name}`,
        })),
      });
    }
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
        return Response.json(
          await serialize(backend, () => backend.syncUsers!(users)),
        );
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
        return Response.json(
          { error: "inboundId must be a number" },
          { status: 400 },
        );
      }

      const conflict = (onConflict as OnConflict | undefined) ?? "skip";
      if (!["skip", "overwrite", "keep-both"].includes(conflict)) {
        return Response.json(
          { error: "onConflict must be skip, overwrite, or keep-both" },
          { status: 400 },
        );
      }

      try {
        const result: SyncResult = await serialize(backend, () =>
          backend.syncUser!(inboundId, email, uuid, conflict),
        );
        return Response.json({ result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`sync-user failed for ${email}:`, msg);
        return Response.json({ result: "failed", msg }, { status: 500 });
      }
    }

    // --- xui: batch, UUID-aware sync of one inbound ---------------------------
    if (action === "/sync-clients" && req.method === "POST") {
      if (!backend.syncClients) return unsupported("/sync-clients", backend);
      const body = await readJsonObject(req);
      if (body instanceof Response) return body;
      const parsed = parseClientSync(body);
      if (typeof parsed === "string")
        return Response.json({ error: parsed }, { status: 400 });
      try {
        return Response.json(
          await serialize(backend, () => backend.syncClients!(parsed)),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("sync-clients failed:", msg);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    if (action === "/check-conflicts" && req.method === "POST") {
      if (!backend.checkConflicts)
        return unsupported("/check-conflicts", backend);

      const body = await readJsonObject(req);
      if (body instanceof Response) return body;

      const { emails } = body;
      if (!Array.isArray(emails) || emails.some((e) => typeof e !== "string")) {
        return Response.json(
          { error: "emails must be an array of strings" },
          { status: 400 },
        );
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
        const result: SyncResult = await serialize(backend, () =>
          backend.deleteUser!(email),
        );
        return Response.json({ result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`delete-user failed for ${email}:`, msg);
        return Response.json({ result: "failed", msg }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}
