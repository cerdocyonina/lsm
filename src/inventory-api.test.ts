import { afterEach, describe, expect, test } from "bun:test";
import { handleAdminApiRequest } from "./admin-api";
import { createSessionCookie } from "./admin-auth";
import { LoginRateLimiter } from "./admin-rate-limit";
import { config, envSchema } from "./env-validation";
import { applyAssignments, syncInventory } from "./inventory";
import { SqliteStorage } from "./storage";
import { renderSubscriptionLinks } from "./subscription";
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function setup() {
  config.init(
    envSchema.parse({
      ADMIN_PORT: 43001,
      BASE_URL: "http://localhost",
      ADMIN_PATH: "ux-refactor-test",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "test-password",
      ADMIN_SESSION_SECRET: "test-session-secret-123",
      SUB_LINK_SECRET: "test-sub-secret-123",
    }),
  );
  const storage = new SqliteStorage(":memory:", "admin");
  cleanup.push(() => storage.close());
  const owner = storage.getPrimaryAdmin().id;
  storage.createProfile("family", owner, 1);
  storage.createProfile("work", owner, 1);
  for (const p of storage.listProfiles(owner))
    storage.addUser(
      p.name,
      "alice",
      `tok-${p.name}`,
      `uuid-${p.name}`,
      1,
      owner,
    );
  const cookie = createSessionCookie(owner).split(";")[0]!;
  async function request(
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    authenticated = true,
  ) {
    const r = await handleAdminApiRequest(
      new Request(`http://localhost/ux-refactor-test/api${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(authenticated ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      `/ux-refactor-test/api${path}`,
      storage,
      (p, n) => `${p}-${n}`,
      "/ux-refactor-test",
      "http://localhost",
      new LoginRateLimiter(),
      "127.0.0.1",
      "test-sub-secret-123",
    );
    if (!r) throw new Error("Missing response");
    return { status: r.status, body: (await r.json()) as any };
  }
  return { storage, owner, request };
}
describe("inventory API", () => {
  test("setup commits one host, three services and nine memberships and syncs all existing users", async () => {
    const { storage, owner, request } = setup();
    const calls: any[] = [];
    const agent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        calls.push({
          path: new URL(req.url).pathname,
          ...((await req.json()) as object),
        });
        return Response.json({ synced: 3 });
      },
    });
    cleanup.push(() => agent.stop(true));
    const r = await request("/inventory/setup", {
      host: { name: "Germany", url: agent.url.origin, secret: "s" },
      services: [
        ["naive", "naive"],
        ["ss2022", "shadowsocks"],
        ["mieru", "mieru"],
      ].map(([name, type]) => ({
        name,
        type,
        path: `/${name}`,
        template: "link-{user}",
        profiles: ["main", "family", "work"],
      })),
    });
    expect(r.status).toBe(200);
    expect(r.body.hosts).toHaveLength(1);
    expect(r.body.connections).toHaveLength(3);
    expect(r.body.memberships).toHaveLength(9);
    expect(r.body.syncResults.every((r: any) => r.ok)).toBe(true);
    expect(calls).toHaveLength(3);
    for (const c of calls)
      expect(c.users.map((u: any) => u.user).sort()).toEqual([
        "family.alice",
        "main.alice",
        "work.alice",
      ]);
    expect(JSON.stringify(r.body)).not.toContain('"secret":');
    expect((await request("/inventory", undefined, "GET", false)).status).toBe(
      401,
    );
    expect(storage.listConnections(owner)).toHaveLength(3);
  });
  test("invalid setup rolls back the entire host and service creation", async () => {
    const { storage, owner, request } = setup();
    const r = await request("/inventory/setup", {
      host: { name: "Germany", url: "http://agent:9000", secret: "s" },
      services: [
        {
          name: "naive",
          type: "naive",
          path: "/naive",
          template: "link",
          profiles: ["main"],
        },
        {
          name: "mieru",
          type: "mieru",
          path: "/mieru",
          template: "link2",
          profiles: ["missing"],
        },
      ],
    });
    expect(r.status).toBe(400);
    expect(storage.listHosts(owner)).toHaveLength(0);
    expect(storage.listNodes(owner)).toHaveLength(0);
    expect(storage.listConnections(owner)).toHaveLength(0);
  });
  test("connection save and assignments are atomic and unassigned services are not pushed empty lists", async () => {
    const { storage, owner, request } = setup();
    let calls = 0;
    const agent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        calls++;
        return Response.json({ synced: 1 });
      },
    });
    cleanup.push(() => agent.stop(true));
    const h = storage.saveHost(null, "host", agent.url.origin, "s", owner);
    const n = storage.saveService(
      null,
      h,
      "naive",
      "/naive",
      "naive",
      0,
      owner,
    );
    const r = await request("/inventory/connections", {
      name: "connection",
      template: "link",
      nodeId: n,
      profiles: [],
    });
    expect(r.status).toBe(200);
    expect(calls).toBe(0);
    const bad = await request("/inventory/connections", {
      id: r.body.id,
      name: "changed",
      template: "changed",
      nodeId: n,
      profiles: ["missing"],
    });
    expect(bad.status).toBe(400);
    expect(storage.listConnections(owner)[0]!.template).toBe("link");
  });
  test("profile display names change subscription output locally and may be cleared", async () => {
    const { storage, owner, request } = setup();
    const id = storage.saveConnection(
      null,
      "shared",
      "vless://{uuid}@host:443#Original",
      null,
      owner,
    );
    storage.assignConnection(id, "main", true, owner);
    storage.assignConnection(id, "work", true, owner);
    expect(
      (
        await request(
          "/profiles/main/servers/shared",
          { displayName: "My connection" },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    expect(
      renderSubscriptionLinks(storage, storage.listUsers("main", owner)[0]!)[0],
    ).toEndWith("#My%20connection");
    expect(
      renderSubscriptionLinks(storage, storage.listUsers("work", owner)[0]!)[0],
    ).toEndWith("#Original");
    await request(
      "/profiles/main/servers/shared",
      { displayName: null },
      "PATCH",
    );
    expect(
      renderSubscriptionLinks(storage, storage.listUsers("main", owner)[0]!)[0],
    ).toEndWith("#Original");
  });
  test("failed xui revocation is persisted for retry after membership removal", async () => {
    const { storage, owner } = setup();
    let fail = true;
    const calls: string[] = [];
    const agent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        calls.push(new URL(req.url).pathname);
        return fail
          ? Response.json({ error: "offline" }, { status: 503 })
          : Response.json({ result: "deleted" });
      },
    });
    cleanup.push(() => agent.stop(true));
    const node = storage.addNode("xui", agent.url.origin, "s", 1, owner, 1);
    const c = storage.saveConnection(null, "c", "link", node.id, owner);
    storage.assignConnection(c, "main", true, owner);
    const change = applyAssignments(storage, owner, {
      assignments: [{ connectionId: c, profile: "main", included: false }],
    });
    expect(
      (await syncInventory(storage, owner, change.ids, change.removed))[0]!.ok,
    ).toBe(false);
    expect(storage.pendingRemovals(node.id, owner)).toHaveLength(1);
    fail = false;
    expect((await syncInventory(storage, owner, [node.id]))[0]!.ok).toBe(true);
    expect(calls).toEqual(["/delete-user", "/delete-user"]);
    expect(storage.pendingRemovals(node.id, owner)).toHaveLength(0);
  });
});

describe("server endpoint (services folded into servers)", () => {
  function agent() {
    const pushes: { path: string; users: string[] }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/health"))
          return Response.json({
            ok: true,
            version: "9.9.9",
            caddy: { ok: true },
            mieru: { ok: path.startsWith("/mieru") ? false : true, error: "down" },
          });
        const body = (await req.json()) as { users: { user: string }[] };
        pushes.push({ path, users: body.users.map((u) => u.user).sort() });
        return Response.json({ synced: body.users.length });
      },
    });
    cleanup.push(() => server.stop(true));
    return { url: server.url.origin, pushes };
  }

  test("servers reuse the host's backend binding, follow retargets and drop unused bindings", async () => {
    const { storage, owner, request } = setup();
    const a = agent();
    const hostId = storage.saveHost(null, "de", a.url, "s", owner);
    const target = { hostId, type: "naive", path: "/naive" };
    const one = await request("/inventory/servers", {
      name: "de-naive",
      template: "naive+https://{user}:{pass}@de.example:443#DE",
      target,
      profiles: ["main"],
    });
    expect(one.status).toBe(200);
    const two = await request("/inventory/servers", {
      name: "de-naive-alt",
      template: "naive+https://{user}:{pass}@alt.example:443#DE alt",
      target,
      profiles: ["work"],
    });
    expect(two.body.services).toHaveLength(1);
    expect(a.pushes.at(-1)).toEqual({
      path: "/naive/sync-users",
      users: ["main.alice", "work.alice"],
    });

    // Moving the first server to another backend: both bindings exist and both get pushed.
    const moved = await request("/inventory/servers", {
      id: one.body.id,
      name: "de-mieru",
      template: "mierus://{user}:{mpass}@{ip}?port=1#DE",
      target: { hostId, type: "mieru", path: "/mieru" },
      profiles: ["main"],
    });
    expect(moved.body.services).toHaveLength(2);
    expect(a.pushes.slice(-2).map((p) => p.path).sort()).toEqual([
      "/mieru/sync-users",
      "/naive/sync-users",
    ]);
    expect(
      storage.listServerRecords("main", owner).map((s) => s.name),
    ).toEqual(["de-mieru"]);

    // Same path with another protocol is a mistake, not a new binding.
    const clash = await request("/inventory/servers", {
      name: "bad",
      template: "x",
      target: { hostId, type: "shadowsocks", path: "/naive" },
    });
    expect(clash.status).toBe(400);
    expect(clash.body.error).toContain("already used");

    // Deleting the last server on /naive revokes its users and forgets the binding.
    const del = await request(
      `/inventory/connections/${two.body.id}`,
      undefined,
      "DELETE",
    );
    expect(a.pushes.at(-1)).toEqual({ path: "/naive/sync-users", users: [] });
    expect(del.body.services.map((s: any) => s.backendPath)).toEqual(["/mieru"]);

    const test = await request(`/inventory/hosts/${hostId}/test`, {});
    expect(test.body.version).toBe("9.9.9");
    expect(test.body.services).toEqual([
      expect.objectContaining({ ok: false, error: "down" }),
    ]);
  });

  test("{ip} needs a host, and deleting a host removes its servers locally", async () => {
    const { storage, owner, request } = setup();
    const noHost = await request("/inventory/servers", {
      name: "x",
      template: "vless://{uuid}@{ip}:443",
      target: null,
    });
    expect(noHost.status).toBe(400);
    const hostId = storage.saveHost(null, "gone", "http://127.0.0.1:9", "s", owner);
    await request("/inventory/servers", {
      name: "x",
      template: "vless://{uuid}@{ip}:443",
      target: { hostId, type: "xui", path: "", inboundId: 2 },
    });
    const plain = await request("/inventory/servers", {
      name: "plain",
      template: "vless://{uuid}@1.2.3.4:443",
      target: null,
      profiles: ["main"],
    });
    expect(plain.status).toBe(200);
    const r = await request(`/inventory/hosts/${hostId}`, undefined, "DELETE");
    expect(r.status).toBe(200);
    expect(r.body.hosts).toHaveLength(0);
    expect(r.body.services).toHaveLength(0);
    expect(r.body.connections.map((c: any) => c.name)).toEqual(["plain"]);
  });
});
