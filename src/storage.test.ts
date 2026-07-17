import { beforeEach, describe, expect, test } from "bun:test";
import { SqliteStorage } from "./storage";

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
