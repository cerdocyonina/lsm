import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDumpOrThrow } from "./app-config";
import { applyAssignments, inventory, syncInventory } from "./inventory";
import { SqliteStorage, buildMultiProfileDump } from "./storage";
import { renderSubscriptionLinks } from "./subscription";
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function fixture() {
  const s = new SqliteStorage(":memory:", "admin");
  cleanup.push(() => s.close());
  const owner = s.getPrimaryAdmin().id;
  s.createProfile("family", owner, 1);
  s.createProfile("work", owner, 1);
  return { s, owner };
}

describe("shared connections and migration", () => {
  test("legacy 3 profiles × 3 services become 1 host and 3 definitions, preserving subscriptions on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsm-migration-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "legacy.sqlite");
    const db = new Database(file);
    db.exec(`
      CREATE TABLE admin_users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,is_primary INTEGER,created_at INTEGER);
      INSERT INTO admin_users VALUES(1,'admin','env:',1,1);
      CREATE TABLE profiles(id INTEGER PRIMARY KEY,owner_id INTEGER,name TEXT,created_at INTEGER,UNIQUE(owner_id,name));
      CREATE TABLE nodes(id INTEGER PRIMARY KEY,owner_id INTEGER,name TEXT UNIQUE,url TEXT,secret TEXT,inbound_id INTEGER,type TEXT,created_at INTEGER);
      CREATE TABLE servers(profile_id INTEGER,name TEXT,sort_order INTEGER,template TEXT,created_at INTEGER,node_id INTEGER,PRIMARY KEY(profile_id,name));
      CREATE TABLE users(profile_id INTEGER,client_name TEXT,user_uuid TEXT,subscription_token TEXT UNIQUE,credentials TEXT,created_at INTEGER,last_fetched_at INTEGER,PRIMARY KEY(profile_id,client_name));
    `);
    const kinds = ["naive", "shadowsocks", "mieru"];
    const paths = ["naive", "ss2022", "mieru"];
    const templates = [
      "naive+https://{user}:{pass}@{ip}:443#Naive",
      "ss://2022-blake3-aes-128-gcm:IPSK==:{sskey}@{ip}:9444#SS",
      "mierus://{user}:{mpass}@{ip}?port=8444-8453&protocol=TCP#Mieru",
    ];
    for (let i = 0; i < 3; i++)
      db.query("INSERT INTO nodes VALUES(?,1,?,?,?,0,?,1)").run(
        i + 1,
        paths[i]!,
        `http://vyrfop:9000/${paths[i]}`,
        "secret",
        kinds[i]!,
      );
    for (let i = 0; i < 3; i++) {
      db.query("INSERT INTO profiles VALUES(?,1,?,1)").run(
        i + 1,
        ["main", "family", "work"][i]!,
      );
      db.query("INSERT INTO users VALUES(?,?,?,?,?,1,123)").run(
        i + 1,
        "alice",
        `uuid-${i}`,
        `token-${i}`,
        JSON.stringify({
          pass: "secret",
          sskey: "AAAAAAAAAAAAAAAAAAAAAA==",
          mpass: "mieru-password",
        }),
      );
      for (let j = 0; j < 3; j++)
        db.query("INSERT INTO servers VALUES(?,?,?,?,1,?)").run(
          i + 1,
          `link-${j}`,
          j,
          templates[j]!,
          j + 1,
        );
    }
    db.close();
    let s = new SqliteStorage(file, "admin");
    expect(s.listHosts(1)).toHaveLength(1);
    expect(s.listConnections(1)).toHaveLength(3);
    expect(s.listNodes(1).map((n) => n.backendPath)).toEqual([
      "/naive",
      "/ss2022",
      "/mieru",
    ]);
    const before = s
      .listProfiles(1)
      .map((p) => renderSubscriptionLinks(s, s.listUsers(p.name, 1)[0]!));
    expect(s.listUsers("main", 1)[0]!.lastFetchedAt).toBe(123);
    expect(s.listServerRecords("main", 1).map((c) => c.name)).toEqual([
      "link-0",
      "link-1",
      "link-2",
    ]);
    s.close();
    s = new SqliteStorage(file, "admin");
    expect(s.listConnections(1)).toHaveLength(3);
    expect(
      s
        .listProfiles(1)
        .map((p) => renderSubscriptionLinks(s, s.listUsers(p.name, 1)[0]!)),
    ).toEqual(before);
    s.close();
  });
  test("shared template edit propagates while aliases and order stay local; new services stay unselected", () => {
    const { s, owner } = fixture();
    const id = s.saveConnection(
      null,
      "Shared",
      "vless://{uuid}@one:443",
      null,
      owner,
    );
    for (const p of s.listProfiles(owner))
      s.assignConnection(id, p.name, true, owner);
    s.renameServer("work", "Shared", "Work name", owner);
    s.saveConnection(id, "Shared", "vless://{uuid}@two:443", null, owner);
    expect(s.listServers("family", owner)).toEqual(["vless://{uuid}@two:443"]);
    expect(s.listServerRecords("work", owner)[0]!.name).toBe("Work name");
    s.saveConnection(null, "New", "vless://{uuid}@three:443", null, owner);
    expect(s.listServerRecords("main", owner)).toHaveLength(1);
  });
  test("ownership and bulk rollback prevent partial or cross-admin assignments", () => {
    const { s, owner } = fixture();
    const c = s.saveConnection(null, "c", "link", null, owner);
    const other = s.createAdminUser("other", "hash", 1);
    expect(() => s.assignConnection(c, "main", true, other.id)).toThrow();
    expect(() =>
      applyAssignments(s, owner, {
        assignments: [
          { connectionId: c, profile: "main", included: true },
          { connectionId: c, profile: "missing", included: true },
        ],
      }),
    ).toThrow();
    expect(s.listServers("main", owner)).toHaveLength(0);
    expect(inventory(s, owner).hosts.some((h: any) => "secret" in h)).toBe(
      false,
    );
  });
  test("complete export/import preserves unassigned definitions, host names and variants", () => {
    const { s, owner } = fixture();
    const h = s.saveHost(null, "Germany", "http://agent:9000", "secret", owner);
    const n = s.saveService(null, h, "Naive", "/naive", "naive", 0, owner);
    const a = s.saveConnection(
      null,
      "one",
      "naive+https://{user}:{pass}@{ip}",
      n,
      owner,
    );
    const b = s.saveConnection(
      null,
      "variant",
      "naive+https://{user}:{pass}@{ip}",
      n,
      owner,
    );
    s.assignConnection(a, "main", true, owner);
    s.assignConnection(b, "work", true, owner);
    s.saveConnection(null, "unused", "vless://unused", null, owner);
    const dump = buildMultiProfileDump(s, owner);
    expect(parseDumpOrThrow(dump).kind).toBe("multi-profile");
    const target = fixture();
    target.s.mergeAllFromMultiProfileDump(dump, target.owner);
    target.s.mergeAllFromMultiProfileDump(dump, target.owner);
    expect(target.s.listConnections(target.owner)).toHaveLength(3);
    expect(target.s.listHosts(target.owner)[0]!.name).toBe("Germany");
    expect(
      target.s.listServerRecords("main", target.owner)[0]!.connectionId,
    ).not.toBe(
      target.s.listServerRecords("work", target.owner)[0]!.connectionId,
    );
  });
  test("assignment sync unions all profiles and removal preserves remaining users", async () => {
    const { s, owner } = fixture();
    const bodies: any[] = [];
    const agent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        bodies.push(await req.json());
        return Response.json({ synced: bodies.at(-1).users.length });
      },
    });
    cleanup.push(() => agent.stop(true));
    const n = s.addNode(
      "naive",
      agent.url.origin,
      "secret",
      0,
      owner,
      1,
      "naive",
    );
    const c = s.saveConnection(
      null,
      "Naive",
      "naive+https://{user}:{pass}@{ip}",
      n.id,
      owner,
    );
    s.addUser("main", "alice", "t1", "u1", 1, owner);
    s.addUser("work", "bob", "t2", "u2", 1, owner);
    let changed = applyAssignments(s, owner, {
      assignments: [
        { connectionId: c, profile: "main", included: true },
        { connectionId: c, profile: "work", included: true },
      ],
    });
    expect(
      (await syncInventory(s, owner, changed.ids, changed.removed))[0]!.ok,
    ).toBe(true);
    expect(
      bodies
        .at(-1)
        .users.map((u: any) => u.user)
        .sort(),
    ).toEqual(["main.alice", "work.bob"]);
    changed = applyAssignments(s, owner, {
      assignments: [{ connectionId: c, profile: "main", included: false }],
    });
    await syncInventory(s, owner, changed.ids, changed.removed);
    expect(bodies.at(-1).users.map((u: any) => u.user)).toEqual(["work.bob"]);
  });
});

describe("label-variant merge (schema v1)", () => {
  function legacyDb(rows: [profile: number, name: string, template: string][]) {
    const dir = mkdtempSync(join(tmpdir(), "lsm-merge-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "legacy.sqlite");
    const db = new Database(file);
    db.exec(`
      CREATE TABLE admin_users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,is_primary INTEGER,created_at INTEGER);
      INSERT INTO admin_users VALUES(1,'admin','env:',1,1);
      CREATE TABLE profiles(id INTEGER PRIMARY KEY,owner_id INTEGER,name TEXT,created_at INTEGER,UNIQUE(owner_id,name));
      INSERT INTO profiles VALUES(1,1,'main',1),(2,1,'par',1),(3,1,'pul',1);
      CREATE TABLE nodes(id INTEGER PRIMARY KEY,owner_id INTEGER,name TEXT UNIQUE,url TEXT,secret TEXT,inbound_id INTEGER,type TEXT,created_at INTEGER);
      INSERT INTO nodes VALUES(1,1,'garfop','http://gar:9000','s',1,'xui',1);
      CREATE TABLE servers(profile_id INTEGER,name TEXT,sort_order INTEGER,template TEXT,created_at INTEGER,node_id INTEGER,PRIMARY KEY(profile_id,name));
      CREATE TABLE users(profile_id INTEGER,client_name TEXT,user_uuid TEXT,subscription_token TEXT UNIQUE,credentials TEXT,created_at INTEGER,last_fetched_at INTEGER,PRIMARY KEY(profile_id,client_name));
    `);
    for (const p of [1, 2, 3])
      db.query("INSERT INTO users VALUES(?,?,?,?,'{}',1,NULL)").run(
        p,
        "alice",
        `uuid-${p}`,
        `token-${p}`,
      );
    rows.forEach(([p, name, template], i) =>
      db
        .query("INSERT INTO servers VALUES(?,?,?,?,1,1)")
        .run(p, name, i, template),
    );
    db.close();
    return file;
  }
  const labels = (s: SqliteStorage) =>
    s
      .listProfiles(1)
      .map((p) =>
        renderSubscriptionLinks(s, s.listUsers(p.name, 1)[0]!).map((l) =>
          decodeURIComponent(l.split("#")[1]!),
        ),
      );

  test("copies differing only by #label become one server with per-profile labels", () => {
    const base = "vless://{uuid}@{ip}:443?type=tcp&security=reality";
    const file = legacyDb([
      [1, "garfop", `${base}#🇩🇪 DE 0`],
      [2, "garfop", `${base}#🇩🇪 DE 0 (основной)`],
      [3, "garfop-pul", `${base}#🇩🇪 DE 0 (main)`],
    ]);
    let s = new SqliteStorage(file, "admin");
    expect(s.listConnections(1)).toHaveLength(1);
    expect(labels(s)).toEqual([
      ["🇩🇪 DE 0"],
      ["🇩🇪 DE 0 (основной)"],
      ["🇩🇪 DE 0 (main)"],
    ]);
    expect(s.listServerRecords("main", 1)[0]!.displayName).toBeNull();
    // Internal entry names are aligned with the server name.
    expect(s.listServerRecords("pul", 1)[0]!.name).toBe("garfop");
    s.close();

    // Runs once: a deliberate label-only copy made later is not folded on restart.
    s = new SqliteStorage(file, "admin");
    const copy = s.saveConnection(null, "copy", `${base}#Other`, 1, 1);
    s.createProfile("fresh", 1, 1);
    s.assignConnection(copy, "fresh", true, 1);
    s.close();
    s = new SqliteStorage(file, "admin");
    expect(s.listConnections(1)).toHaveLength(2);
    s.close();
  });

  test("copies used twice by the same profile stay separate", () => {
    const file = legacyDb([
      [1, "a", "vless://{uuid}@{ip}:443#A"],
      [1, "b", "vless://{uuid}@{ip}:443#B"],
      [2, "a", "vless://{uuid}@{ip}:443#A2"],
    ]);
    const s = new SqliteStorage(file, "admin");
    cleanup.push(() => s.close());
    // "a"(main) absorbs "a"(par); "b" shares main with it, so it stays its own server.
    expect(s.listConnections(1)).toHaveLength(2);
    expect(labels(s)).toEqual([["A", "B"], ["A2"], []]);
  });
});
