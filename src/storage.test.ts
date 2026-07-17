import { beforeEach, describe, expect, test } from "bun:test";
import { buildProfileDump, SqliteStorage } from "./storage";

function newStorage(): SqliteStorage {
  return new SqliteStorage(":memory:", "admin");
}

function ownerId(storage: SqliteStorage): number {
  return storage.getPrimaryAdmin().id;
}

describe("user credentials", () => {
  let storage: SqliteStorage;
  let owner: number;

  beforeEach(() => {
    storage = newStorage();
    owner = ownerId(storage);
    storage.addUser("main", "alice", "tok-alice", "uuid-alice", 1000, owner);
  });

  test("новый юзер стартует с пустым мешком", () => {
    expect(storage.listUsers("main", owner)[0]!.credentials).toEqual({});
  });

  test("setUserCredentials сохраняет и читается обратно", () => {
    storage.setUserCredentials("main", "alice", { user: "alice", pass: "p1" }, owner);
    expect(storage.listUsers("main", owner)[0]!.credentials).toEqual({ user: "alice", pass: "p1" });
  });

  test("setUserCredentials мержит, а не перетирает", () => {
    storage.setUserCredentials("main", "alice", { user: "alice" }, owner);
    storage.setUserCredentials("main", "alice", { pass: "p1" }, owner);
    expect(storage.listUsers("main", owner)[0]!.credentials).toEqual({ user: "alice", pass: "p1" });
  });

  test("getUserBySubscriptionToken тоже отдаёт мешок", () => {
    storage.setUserCredentials("main", "alice", { pass: "p1" }, owner);
    expect(storage.getUserBySubscriptionToken("tok-alice")!.credentials).toEqual({ pass: "p1" });
  });

  test("неизвестный юзер — false", () => {
    expect(storage.setUserCredentials("main", "nobody", { pass: "x" }, owner)).toBe(false);
  });
});

describe("node type", () => {
  let storage: SqliteStorage;
  let owner: number;

  beforeEach(() => {
    storage = newStorage();
    owner = ownerId(storage);
  });

  test("по умолчанию xui — обратная совместимость", () => {
    const node = storage.addNode("n1", "http://n1:9000", "s", 1, owner, 1000);
    expect(node.type).toBe("xui");
  });

  test("naive-нода сохраняет тип и допускает inboundId=0", () => {
    const node = storage.addNode("n2", "http://n2:9000", "s", 0, owner, 1000, "naive");
    expect(node.type).toBe("naive");
    expect(node.inboundId).toBe(0);
    expect(storage.getNode(node.id, owner)!.type).toBe("naive");
  });

  test("listNodes отдаёт тип", () => {
    storage.addNode("n2", "http://n2:9000", "s", 0, owner, 1000, "naive");
    expect(storage.listNodes(owner)[0]!.type).toBe("naive");
  });

  test("updateNode меняет тип", () => {
    const node = storage.addNode("n1", "http://n1:9000", "s", 1, owner, 1000);
    expect(storage.updateNode(node.id, owner, { type: "naive" })).toBe(true);
    expect(storage.getNode(node.id, owner)!.type).toBe("naive");
  });
});

describe("dump round-trip", () => {
  test("credentials и type переживают export → import", () => {
    const source = newStorage();
    const owner = ownerId(source);
    source.addUser("main", "alice", "tok-alice", "uuid-alice", 1000, owner);
    source.setUserCredentials("main", "alice", { user: "alice", pass: "p1" }, owner);
    const node = source.addNode("naive-1", "http://n:9000", "sec", 0, owner, 1000, "naive");
    source.addServer("main", "s1", "naive+https://{user}:{pass}@h:443#n", 1000, owner, node.id);

    const dump = buildProfileDump(source, "main", owner);
    expect(dump.USERS[0]!.credentials).toEqual({ user: "alice", pass: "p1" });
    expect(dump.NODES![0]!.type).toBe("naive");
    expect(dump.NODES![0]!.inboundId).toBe(0);

    const target = newStorage();
    const targetOwner = ownerId(target);
    target.replaceProfileFromFullDump("main", dump, targetOwner);

    expect(target.listUsers("main", targetOwner)[0]!.credentials).toEqual({ user: "alice", pass: "p1" });
    expect(target.listNodes(targetOwner)[0]!.type).toBe("naive");
  });

  test("дамп без credentials/type читается со значениями по умолчанию", () => {
    const target = newStorage();
    const owner = ownerId(target);
    target.replaceProfileFromFullDump(
      "main",
      {
        USERS: [{ clientName: "bob", userUuid: "550e8400-e29b-41d4-a716-446655440000", subscriptionToken: "tok-bob", createdAt: 1 }],
        SERVERS: [{ name: "s1", sortOrder: 0, template: "vless://DUMMY@h#n", createdAt: 1, nodeName: null }],
        NODES: [{ name: "legacy", url: "http://n:9000", secret: "s", inboundId: 1, createdAt: 1 }],
      },
      owner,
    );
    expect(target.listUsers("main", owner)[0]!.credentials).toEqual({});
    expect(target.listNodes(owner)[0]!.type).toBe("xui");
  });
});
