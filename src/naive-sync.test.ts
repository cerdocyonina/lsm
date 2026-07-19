import { beforeEach, describe, expect, test } from "bun:test";
import { buildNaiveUsersForNode } from "./naive-sync";
import { SqliteStorage } from "./storage";

const NAIVE = "naive+https://{user}:{pass}@h:443#n";

describe("buildNaiveUsersForNode", () => {
  let storage: SqliteStorage;
  let owner: number;
  let nodeId: number;

  beforeEach(() => {
    storage = new SqliteStorage(":memory:", "admin");
    owner = storage.getPrimaryAdmin().id;
    // "main" уже есть по умолчанию; добавляем ещё профили
    storage.createProfile("par", owner, 0);
    storage.createProfile("pul", owner, 0);
    nodeId = storage.addNode("hosfop", "http://x:9000", "sek", 0, owner, 0, "naive").id;
  });

  test("объединяет юзеров всех профилей, привязанных к ноде; логин namespace-нут профилем", () => {
    storage.addServer("main", "s-main", NAIVE, 0, owner, nodeId);
    storage.addServer("par", "s-par", NAIVE, 0, owner, nodeId);
    storage.addUser("main", "alice", "t1", "u1", 1000, owner);
    storage.addUser("par", "bob", "t2", "u2", 1001, owner);

    const { users, skipped } = buildNaiveUsersForNode(storage, nodeId, owner);
    expect(users.map((u) => u.user).sort()).toEqual(["main.alice", "par.bob"]);
    expect(skipped).toEqual([]);
  });

  test("КЛЮЧЕВОЙ КЕЙС: одинаковый clientName в двух профилях — оба логина различны, оба сохраняются", () => {
    storage.addServer("main", "s-main", NAIVE, 0, owner, nodeId);
    storage.addServer("par", "s-par", NAIVE, 0, owner, nodeId);
    storage.addUser("main", "client1", "t1", "u1", 1000, owner);
    storage.addUser("par", "client1", "t2", "u2", 1001, owner); // тот же clientName, другой человек

    const { users } = buildNaiveUsersForNode(storage, nodeId, owner);
    expect(users.map((u) => u.user).sort()).toEqual(["main.client1", "par.client1"]);
    const byLogin = Object.fromEntries(users.map((u) => [u.user, u.pass]));
    expect(byLogin["main.client1"]).not.toBe(byLogin["par.client1"]); // разные креды у разных людей
  });

  test("профиль без сервера на этой ноде исключён", () => {
    const other = storage.addNode("solo", "http://y:9000", "sek", 0, owner, 0, "naive").id;
    storage.addServer("main", "s-main", NAIVE, 0, owner, nodeId);
    storage.addServer("pul", "s-pul", NAIVE, 0, owner, other); // pul на ДРУГОЙ ноде
    storage.addUser("main", "alice", "t1", "u1", 1000, owner);
    storage.addUser("pul", "charlie", "t2", "u2", 1001, owner);

    const { users } = buildNaiveUsersForNode(storage, nodeId, owner);
    expect(users.map((u) => u.user)).toEqual(["main.alice"]);
  });

  test("пароль persist-ится и стабилен между вызовами — тот же, что отдаст подписка", () => {
    storage.addServer("main", "s-main", NAIVE, 0, owner, nodeId);
    storage.addUser("main", "alice", "t1", "u1", 1000, owner);

    const first = buildNaiveUsersForNode(storage, nodeId, owner);
    const second = buildNaiveUsersForNode(storage, nodeId, owner);
    expect(second).toEqual(first);
    expect(storage.listUsers("main", owner)[0]!.credentials.pass).toBe(first.users[0]!.pass);
  });

  test("невалидное имя пропускается как profile/client, валидные синкаются", () => {
    storage.addServer("main", "s-main", NAIVE, 0, owner, nodeId);
    storage.addUser("main", "alice", "t1", "u1", 1000, owner);
    storage.addUser("main", "has@at", "t2", "u2", 1001, owner); // @ вне charset

    const { users, skipped } = buildNaiveUsersForNode(storage, nodeId, owner);
    expect(users.map((u) => u.user)).toEqual(["main.alice"]);
    expect(skipped).toEqual(["main/has@at"]);
  });

  test("нет привязанных профилей — пустой результат", () => {
    expect(buildNaiveUsersForNode(storage, nodeId, owner)).toEqual({ users: [], skipped: [] });
  });
});
