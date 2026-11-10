import { describe, expect, test } from "bun:test";
import type { NodeBackend } from "./backends/types";
import { createAgentHandler } from "./server";

describe("agent HTTP compatibility and discovery", () => {
  function fixture() {
    const received: unknown[] = [];
    const make = (kind: NodeBackend["kind"]): NodeBackend => ({
      kind,
      health: async () => ({ ok: true }),
      syncUsers: async (users) => {
        received.push({ kind, users });
        return { synced: users.length };
      },
    });
    const backends = new Map([
      ["naive", make("naive")],
      ["ss2022", make("shadowsocks")],
      ["mieru", make("mieru")],
    ]);
    return {
      received,
      handler: createAgentHandler(
        { backends, defaultName: "naive" },
        "secret",
        { version: "test" },
      ),
    };
  }
  function req(path: string, body?: unknown, secret = "secret") {
    return new Request(`http://agent${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  test("discovery authenticates and reveals no backend secrets", async () => {
    const { handler } = fixture();
    expect((await handler(req("/backends", undefined, "bad"))).status).toBe(
      401,
    );
    const r: any = await (await handler(req("/backends"))).json();
    expect(r.backends).toEqual([
      { name: "naive", kind: "naive", path: "/naive" },
      { name: "ss2022", kind: "shadowsocks", path: "/ss2022" },
      { name: "mieru", kind: "mieru", path: "/mieru" },
    ]);
    expect(r.default).toBe("naive");
  });
  test("vyrfop's named routes and default route retain their behavior", async () => {
    const { handler, received } = fixture();
    for (const path of [
      "/sync-users",
      "/naive/sync-users",
      "/ss2022/sync-users",
      "/mieru/sync-users",
    ])
      expect(
        (
          await handler(
            req(path, { users: [{ user: "main.alice", pass: "password" }] }),
          )
        ).status,
      ).toBe(200);
    expect(received.map((r: any) => r.kind)).toEqual([
      "naive",
      "naive",
      "shadowsocks",
      "mieru",
    ]);
    const health: any = await (await handler(req("/mieru/health"))).json();
    expect(health.mieru.ok).toBe(true);
    expect(
      (await handler(req("/missing/sync-users", { users: [] }))).status,
    ).toBe(404);
  });
  test("concurrent config replacements never overlap", async () => {
    let active = 0,
      max = 0;
    const node: NodeBackend = {
      kind: "naive",
      health: async () => ({ ok: true }),
      syncUsers: async (users) => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { synced: users.length };
      },
    };
    const handler = createAgentHandler(
      { backends: new Map([["naive", node]]), defaultName: "naive" },
      "secret",
      { version: "test" },
    );
    await Promise.all([
      handler(req("/sync-users", { users: [] })),
      handler(req("/naive/sync-users", { users: [] })),
    ]);
    expect(max).toBe(1);
  });
});
