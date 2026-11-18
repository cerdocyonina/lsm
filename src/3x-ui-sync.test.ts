import { afterEach, describe, expect, test } from "bun:test";
import { fullClientBody, VISION_FLOW, XUIService } from "./3x-ui";

type Client = {
  email: string;
  uuid: string;
  inboundIds: number[];
  totalGB: number;
  enable: boolean;
  flow: string;
  limitIp: number;
  comment: string;
  subId: string;
};
const client = (c: Partial<Client> & Pick<Client, "email" | "uuid">): Client => ({
  inboundIds: [1],
  totalGB: 0,
  enable: true,
  flow: VISION_FLOW,
  limitIp: 0,
  comment: "",
  subId: `sub-${c.email}`,
  ...c,
});

/**
 * Stand-in for released 3x-ui (≤ 3.11): session/CSRF login plus /panel/api/clients/*.
 * Its update binds the body as a whole client, so every field the body leaves out is
 * reset (enable → false, flow → "", limits → 0); only an empty UUID or subId is kept.
 */
function fakePanel(initial: Client[], { listWithoutUuid = false } = {}) {
  const clients = new Map(initial.map((c) => [c.email, { ...c }]));
  const calls: string[] = [];
  const record = (c: Client, i = 0) => ({
    id: i + 1, // row number, not the UUID
    email: c.email,
    uuid: c.uuid,
    flow: c.flow,
    enable: c.enable,
    totalGB: c.totalGB,
    limitIp: c.limitIp,
    comment: c.comment,
    subId: c.subId,
    expiryTime: 0,
    tgId: 0,
    reverse: "",
  });
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
        return ok(
          [...clients.values()].map((c, i) => {
            const { uuid, ...rest } = record(c, i);
            return { ...rest, ...(listWithoutUuid ? {} : { uuid }), inboundIds: c.inboundIds };
          }),
        );
      let m = path.match(/^\/panel\/api\/clients\/get\/(.+)$/);
      if (m) {
        const c = clients.get(m[1]!);
        return c ? ok({ client: record(c), inboundIds: c.inboundIds }) : fail("record not found");
      }
      if (path === "/panel/api/clients/add") {
        if (clients.has(body.client.email)) return fail("Duplicate email");
        clients.set(body.client.email, client({ ...body.client, uuid: body.client.id, inboundIds: body.inboundIds }));
        return ok();
      }
      if ((m = path.match(/^\/panel\/api\/clients\/update\/(.+)$/))) {
        const c = clients.get(m[1]!);
        if (!c) return fail("not found");
        if (typeof body.id === "number") return fail("json: cannot unmarshal number into Go struct field Client.id");
        const next: Client = {
          email: body.email ?? "",
          uuid: body.id || c.uuid,
          inboundIds: c.inboundIds,
          totalGB: body.totalGB ?? 0,
          enable: body.enable ?? false,
          flow: body.flow ?? "",
          limitIp: body.limitIp ?? 0,
          comment: body.comment ?? "",
          subId: body.subId || c.subId,
        };
        if (!next.email) return fail("client email is required");
        if (next.email !== c.email && clients.has(next.email)) return fail(`Duplicate email: ${next.email}`);
        clients.delete(c.email);
        clients.set(next.email, next);
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
function setup(initial: Client[], options?: { listWithoutUuid?: boolean }) {
  const panel = fakePanel(initial, options);
  stops.push(panel.stop);
  return { panel, xui: new XUIService({ host: panel.url, user: "u", password: "p" }) };
}
const settings = (c: Client | undefined) => c && { enable: c.enable, flow: c.flow, totalGB: c.totalGB, limitIp: c.limitIp, comment: c.comment };

describe("XUIService.syncClients against a fake panel", () => {
  test("migration renames in place (keeping every setting), adds the namesake, revokes by UUID", async () => {
    const { panel, xui } = setup([
      client({ email: "client1", uuid: "A", totalGB: 50, limitIp: 2, comment: "phone" }),
      client({ email: "client9", uuid: "OLD-9" }),
      client({ email: "manual", uuid: "M" }),
    ]);
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
    expect(preview.fullWrites).toBe(true);
    expect(panel.calls).toEqual(["GET /panel/api/clients/list"]); // dry run writes nothing

    const { results } = await xui.syncClients(request);
    expect(results.every((r) => r.ok)).toBe(true);
    expect([...panel.clients.keys()].sort()).toEqual(["main.client1", "manual", "par.client1"]);
    // The regression: a rename sent as { email } alone came back disabled, without flow or limits.
    expect(settings(panel.clients.get("main.client1"))).toEqual({
      enable: true,
      flow: VISION_FLOW,
      totalGB: 50,
      limitIp: 2,
      comment: "phone",
    });
    expect(panel.clients.get("main.client1")!.subId).toBe("sub-client1");

    // Second run is a no-op.
    const again = await xui.syncClients({ ...request, remove: [] });
    expect(again.results.map((r) => r.kind)).toEqual(["unchanged", "unchanged"]);
  });

  test("clients an older agent's rename switched off are reported, and re-enabled only on request", async () => {
    const { panel, xui } = setup([
      // What lsmnode 2.0–2.1 left behind on released 3x-ui.
      client({ email: "main.client1", uuid: "A", enable: false, flow: "", totalGB: 50 }),
      client({ email: "main.client2", uuid: "C" }),
    ]);
    const request = {
      inboundId: 1,
      clients: [
        { email: "main.client1", uuid: "A", legacyEmail: "client1" },
        { email: "main.client2", uuid: "C", legacyEmail: "client2" },
      ],
      onConflict: "skip" as const,
    };

    const plain = await xui.syncClients(request);
    expect(plain.results.map((r) => r.kind)).toEqual(["disabled", "unchanged"]);
    expect(panel.clients.get("main.client1")!.enable).toBe(false); // a normal push leaves it alone

    const { results } = await xui.syncClients({ ...request, repair: true });
    expect(results.map((r) => [r.kind, r.ok])).toEqual([
      ["repair", true],
      ["unchanged", true],
    ]);
    expect(settings(panel.clients.get("main.client1"))).toEqual({
      enable: true,
      flow: VISION_FLOW,
      totalGB: 50,
      limitIp: 0,
      comment: "",
    });
  });

  test("a working old copy stays until its renamed twin is re-enabled", async () => {
    const { panel, xui } = setup([
      client({ email: "client1", uuid: "A" }),
      client({ email: "main.client1", uuid: "A", enable: false, flow: "" }),
    ]);
    const request = { inboundId: 1, clients: [{ email: "main.client1", uuid: "A", legacyEmail: "client1" }], onConflict: "skip" as const };

    const plain = await xui.syncClients({ ...request, dryRun: true });
    expect(plain.results.map((r) => r.kind)).toEqual(["disabled"]);

    const { results } = await xui.syncClients({ ...request, repair: true });
    expect(results.map((r) => r.kind)).toEqual(["repair", "delete"]);
    expect([...panel.clients.keys()]).toEqual(["main.client1"]);
    expect(panel.clients.get("main.client1")!.enable).toBe(true);
  });

  test("overwrite replaces only the UUID", async () => {
    const { panel, xui } = setup([client({ email: "main.a", uuid: "OLD", totalGB: 10 })], { listWithoutUuid: true });
    const { results } = await xui.syncClients({
      inboundId: 1,
      clients: [{ email: "main.a", uuid: "NEW" }],
      onConflict: "overwrite",
    });
    expect(results).toEqual([{ kind: "overwrite", email: "main.a", uuid: "NEW", attach: false, ok: true }]);
    expect(panel.clients.get("main.a")!.uuid).toBe("NEW");
    expect(settings(panel.clients.get("main.a"))).toMatchObject({ enable: true, flow: VISION_FLOW, totalGB: 10 });
  });

  test("a UUID LSM revoked under the same name is overwritten without asking", async () => {
    const { panel, xui } = setup([client({ email: "main.a", uuid: "OLD" })]);
    const { results } = await xui.syncClients({
      inboundId: 1,
      clients: [{ email: "main.a", uuid: "NEW", legacyEmail: "a" }],
      remove: [{ email: "main.a", uuid: "OLD" }],
      onConflict: "skip",
    });
    expect(results.map((r) => [r.kind, r.ok])).toEqual([
      ["overwrite", true],
      ["not-found", true],
    ]);
    expect(panel.clients.get("main.a")!.uuid).toBe("NEW");
  });

  test("a client on several inbounds is detached, not deleted", async () => {
    const { panel, xui } = setup([client({ email: "main.a", uuid: "A", inboundIds: [1, 2] })]);
    await xui.syncClients({ inboundId: 1, clients: [], remove: [{ email: "main.a", uuid: "A" }], onConflict: "skip" });
    expect(panel.clients.get("main.a")!.inboundIds).toEqual([2]);
  });
});

describe("fullClientBody", () => {
  test("turns a stored record back into a write body", () => {
    expect(
      fullClientBody({
        id: 7,
        uuid: "U",
        email: "main.a",
        flow: VISION_FLOW,
        enable: true,
        totalGB: 5,
        subId: "s",
        reverse: '{"tag":"r"}',
        createdAt: 1,
        inboundIds: [1],
      }),
    ).toEqual({ id: "U", email: "main.a", flow: VISION_FLOW, enable: true, totalGB: 5, subId: "s", reverse: { tag: "r" } });
  });

  test("leaves an empty flow out so newer panels keep each inbound's own", () => {
    expect(fullClientBody({ id: 1, uuid: "U", email: "a", flow: "", enable: false })).toEqual({ id: "U", email: "a", enable: false });
  });
});
