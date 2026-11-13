import { afterEach, describe, expect, test } from "bun:test";
import { XUIService } from "./3x-ui";

type Client = { email: string; uuid: string; inboundIds: number[]; totalGB: number };

/** Minimal 3x-ui 3.5 stand-in: session/CSRF login plus the documented /panel/api/clients/* calls. */
function fakePanel(initial: Client[], { listWithoutUuid = false } = {}) {
  const clients = new Map(initial.map((c) => [c.email, { ...c }]));
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const ok = (obj?: unknown) =>
        Response.json({ success: true, obj }, { headers: { "set-cookie": "3x-ui=session; Path=/" } });
      const fail = (msg: string) => Response.json({ success: false, msg });
      if (path === "/csrf-token") return ok("token");
      if (path === "/login") return ok();
      calls.push(`${req.method} ${path}`);
      const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (path === "/panel/api/clients/list")
        return ok([...clients.values()].map((c, i) => ({ id: i + 1, email: c.email, ...(listWithoutUuid ? {} : { uuid: c.uuid }), inboundIds: c.inboundIds })));
      let m = path.match(/^\/panel\/api\/clients\/get\/(.+)$/);
      if (m) {
        const c = clients.get(m[1]!);
        return ok(c ? { client: { id: 0, uuid: c.uuid, email: c.email }, inboundIds: c.inboundIds } : null);
      }
      if (path === "/panel/api/clients/add") {
        if (clients.has(body.client.email)) return fail("Duplicate email");
        clients.set(body.client.email, { email: body.client.email, uuid: body.client.id, inboundIds: body.inboundIds, totalGB: 0 });
        return ok();
      }
      if ((m = path.match(/^\/panel\/api\/clients\/update\/(.+)$/))) {
        const c = clients.get(m[1]!);
        if (!c) return fail("not found");
        // Partial update; this panel version takes the UUID as `uuid` and ignores a string `id`.
        if (body.uuid) c.uuid = body.uuid;
        if (body.email && body.email !== c.email) {
          clients.delete(c.email);
          c.email = body.email;
          clients.set(c.email, c);
        }
        return ok();
      }
      if ((m = path.match(/^\/panel\/api\/clients\/del\/(.+)$/))) return clients.delete(m[1]!) ? ok() : fail("not found");
      if ((m = path.match(/^\/panel\/api\/clients\/(.+)\/(attach|detach)$/))) {
        const c = clients.get(m[1]!);
        if (!c) return fail("not found");
        c.inboundIds =
          m[2] === "attach" ? [...new Set([...c.inboundIds, ...body.inboundIds])] : c.inboundIds.filter((id) => !body.inboundIds.includes(id));
        return ok();
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: server.url.origin, clients, calls, stop: () => server.stop(true) };
}

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

describe("XUIService.syncClients against a fake panel", () => {
  test("migration renames in place (keeping stats), adds the namesake, revokes by UUID", async () => {
    const panel = fakePanel([
      { email: "client1", uuid: "A", inboundIds: [1], totalGB: 50 },
      { email: "client9", uuid: "OLD-9", inboundIds: [1], totalGB: 0 },
      { email: "manual", uuid: "M", inboundIds: [1], totalGB: 0 },
    ]);
    stops.push(panel.stop);
    const xui = new XUIService({ host: panel.url, user: "u", password: "p" });
    const request = {
      inboundId: 1,
      clients: [
        { email: "main.client1", uuid: "A", legacyEmail: "client1" },
        { email: "par.client1", uuid: "B", legacyEmail: "client1" },
      ],
      remove: [{ email: "main.client9", uuid: "OLD-9" }],
      onConflict: "skip" as const,
    };

    const preview = await xui.syncClients({ ...request, dryRun: true });
    expect(preview.results.map((r) => r.kind)).toEqual(["rename", "add", "delete"]);
    expect(panel.calls).toEqual(["GET /panel/api/clients/list"]); // dry run writes nothing

    const { results } = await xui.syncClients(request);
    expect(results.every((r) => r.ok)).toBe(true);
    expect([...panel.clients.keys()].sort()).toEqual(["main.client1", "manual", "par.client1"]);
    expect(panel.clients.get("main.client1")!.totalGB).toBe(50); // same record, renamed

    // Second run is a no-op.
    const again = await xui.syncClients({ ...request, remove: [] });
    expect(again.results.map((r) => r.kind)).toEqual(["unchanged", "unchanged"]);
  });

  test("overwrite verifies the UUID change and falls back to the other field name", async () => {
    const panel = fakePanel([{ email: "main.a", uuid: "OLD", inboundIds: [1], totalGB: 0 }], { listWithoutUuid: true });
    stops.push(panel.stop);
    const xui = new XUIService({ host: panel.url, user: "u", password: "p" });
    const { results } = await xui.syncClients({
      inboundId: 1,
      clients: [{ email: "main.a", uuid: "NEW" }],
      onConflict: "overwrite",
    });
    expect(results).toEqual([{ kind: "overwrite", email: "main.a", uuid: "NEW", attach: false, ok: true }]);
    expect(panel.clients.get("main.a")!.uuid).toBe("NEW");
  });

  test("a client on several inbounds is detached, not deleted", async () => {
    const panel = fakePanel([{ email: "main.a", uuid: "A", inboundIds: [1, 2], totalGB: 0 }]);
    stops.push(panel.stop);
    const xui = new XUIService({ host: panel.url, user: "u", password: "p" });
    await xui.syncClients({ inboundId: 1, clients: [], remove: [{ email: "main.a", uuid: "A" }], onConflict: "skip" });
    expect(panel.clients.get("main.a")!.inboundIds).toEqual([2]);
  });
});
