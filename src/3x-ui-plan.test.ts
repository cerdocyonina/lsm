import { describe, expect, test } from "bun:test";
import { planClientSync, type ClientSyncRequest, type PanelClient } from "./3x-ui";

const req = (over: Partial<ClientSyncRequest>): ClientSyncRequest => ({
  inboundId: 1,
  clients: [],
  onConflict: "skip",
  ...over,
});

describe("planClientSync", () => {
  test("pre-1.7 plain names are renamed by UUID; the other profile's namesake is added", () => {
    // Panel has main's client1 (it won the old email race); par's client1 never got in.
    const panel: PanelClient[] = [{ email: "client1", uuid: "A", inboundIds: [1] }];
    const steps = planClientSync(
      panel,
      req({
        clients: [
          { email: "par.client1", uuid: "B", legacyEmail: "client1" },
          { email: "main.client1", uuid: "A", legacyEmail: "client1" },
        ],
      }),
    );
    expect(steps).toEqual([
      { kind: "add", email: "par.client1", uuid: "B" },
      { kind: "rename", email: "main.client1", from: "client1", uuid: "A", attach: false },
    ]);
  });

  test("already migrated clients are left alone; missing inbound gets attached", () => {
    const panel: PanelClient[] = [
      { email: "main.a", uuid: "A", inboundIds: [1] },
      { email: "main.b", uuid: "B", inboundIds: [2] },
    ];
    expect(
      planClientSync(
        panel,
        req({ clients: [{ email: "main.a", uuid: "A" }, { email: "main.b", uuid: "B" }] }),
      ).map((s) => s.kind),
    ).toEqual(["unchanged", "attach"]);
  });

  test("renamed users and renamed profiles follow by UUID", () => {
    const panel: PanelClient[] = [
      { email: "main.old", uuid: "A", inboundIds: [1] },
      { email: "work.bob", uuid: "B", inboundIds: [1] },
    ];
    const steps = planClientSync(
      panel,
      req({
        clients: [
          { email: "main.new", uuid: "A", legacyEmail: "new" },
          { email: "office.bob", uuid: "B", legacyEmail: "bob" },
        ],
      }),
    );
    expect(steps.map((s) => s.kind === "rename" && `${s.from}→${s.email}`)).toEqual([
      "main.old→main.new",
      "work.bob→office.bob",
    ]);
  });

  test("a stranger with the same UUID under an unrelated name is not hijacked", () => {
    const panel: PanelClient[] = [{ email: "phone-of-alice", uuid: "A", inboundIds: [1] }];
    expect(
      planClientSync(panel, req({ clients: [{ email: "main.alice", uuid: "A", legacyEmail: "alice" }] }))[0]!.kind,
    ).toBe("add");
  });

  test("conflict strategies", () => {
    const panel: PanelClient[] = [
      { email: "main.a", uuid: "OLD", inboundIds: [1] },
      { email: "main.a_1", uuid: "X", inboundIds: [1] },
    ];
    const clients = [{ email: "main.a", uuid: "NEW" }];
    expect(planClientSync(panel, req({ clients }))[0]).toMatchObject({ kind: "conflict" });
    expect(planClientSync(panel, req({ clients, onConflict: "overwrite" }))[0]).toEqual({
      kind: "overwrite",
      email: "main.a",
      uuid: "NEW",
      attach: false,
    });
    expect(planClientSync(panel, req({ clients, onConflict: "keep-both" }))[0]).toMatchObject({
      kind: "keep-both",
      as: "main.a_2",
    });
  });

  test("unknown UUID on the panel is reported, never written over", () => {
    const steps = planClientSync([{ email: "main.a" }], req({ clients: [{ email: "main.a", uuid: "A" }], onConflict: "overwrite" }));
    expect(steps[0]).toMatchObject({ kind: "conflict" });
  });

  test("revocations match by UUID, under either naming scheme, and detach from shared clients", () => {
    const panel: PanelClient[] = [
      { email: "client1", uuid: "A", inboundIds: [1] }, // legacy name, revoked as main.client1
      { email: "main.client2", uuid: "B", inboundIds: [1, 2] }, // also on another inbound
      { email: "client3", uuid: "STRANGER", inboundIds: [1] }, // same name, someone else
    ];
    const steps = planClientSync(
      panel,
      req({
        remove: [
          { email: "main.client1", uuid: "A" },
          { email: "client2", uuid: "B" },
          { email: "main.client3", uuid: "C" },
        ],
      }),
    );
    expect(steps).toEqual([
      { kind: "delete", email: "client1", uuid: "A", reason: "revoked" },
      { kind: "detach", email: "main.client2", uuid: "B", reason: "revoked" },
      { kind: "not-found", email: "main.client3", uuid: "C" },
    ]);
  });

  test("a leftover legacy copy beside the migrated client is removed when fully covered", () => {
    const panel: PanelClient[] = [
      { email: "main.a", uuid: "A", inboundIds: [1] },
      { email: "a", uuid: "A", inboundIds: [1] },
      { email: "main.b", uuid: "B", inboundIds: [1] },
      { email: "b", uuid: "B", inboundIds: [1, 9] }, // also elsewhere: keep
    ];
    const steps = planClientSync(
      panel,
      req({ clients: [{ email: "main.a", uuid: "A", legacyEmail: "a" }, { email: "main.b", uuid: "B", legacyEmail: "b" }] }),
    );
    expect(steps).toEqual([
      { kind: "unchanged", email: "main.a", uuid: "A" },
      { kind: "delete", email: "a", uuid: "A", reason: "duplicate" },
      { kind: "unchanged", email: "main.b", uuid: "B" },
    ]);
  });
});
