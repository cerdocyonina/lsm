import { beforeEach, describe, expect, test } from "bun:test";
import { buildNaiveUsersForNode, buildShadowsocksUsersForNode } from "./naive-sync";
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

const SS = "ss://2022-blake3-aes-128-gcm:IPSK==:{sskey}@h:9444#ss";

describe("buildShadowsocksUsersForNode", () => {
  let storage: SqliteStorage;
  let owner: number;
  let nodeId: number;

  beforeEach(() => {
    storage = new SqliteStorage(":memory:", "admin");
    owner = storage.getPrimaryAdmin().id;
    storage.createProfile("par", owner, 0);
    nodeId = storage.addNode("hosfop", "http://x:9000/ss2022", "sek", 0, owner, 0, "shadowsocks").id;
  });

  test("объединяет юзеров профилей; метка namespace-нута, PSK — стандартный base64", () => {
    storage.addServer("main", "s-main", SS, 0, owner, nodeId);
    storage.addServer("par", "s-par", SS, 0, owner, nodeId);
    storage.addUser("main", "alice", "t1", "u1", 1000, owner);
    storage.addUser("par", "bob", "t2", "u2", 1001, owner);

    const { users, skipped } = buildShadowsocksUsersForNode(storage, nodeId, owner);
    expect(users.map((u) => u.user).sort()).toEqual(["main.alice", "par.bob"]);
    expect(skipped).toEqual([]);
    // 16 байт в стандартном base64 = 24 символа с "==" на конце (то, что ждёт Xray).
    for (const u of users) expect(u.pass).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  test("одинаковый clientName в двух профилях → метки различны, PSK разные", () => {
    storage.addServer("main", "s-main", SS, 0, owner, nodeId);
    storage.addServer("par", "s-par", SS, 0, owner, nodeId);
    storage.addUser("main", "client1", "t1", "u1", 1000, owner);
    storage.addUser("par", "client1", "t2", "u2", 1001, owner);

    const { users } = buildShadowsocksUsersForNode(storage, nodeId, owner);
    const byLabel = Object.fromEntries(users.map((u) => [u.user, u.pass]));
    expect(Object.keys(byLabel).sort()).toEqual(["main.client1", "par.client1"]);
    expect(byLabel["main.client1"]).not.toBe(byLabel["par.client1"]);
  });

  test("PSK стабилен между вызовами и совпадает с мешком кредов", () => {
    storage.addServer("main", "s-main", SS, 0, owner, nodeId);
    storage.addUser("main", "alice", "t1", "u1", 1000, owner);

    const first = buildShadowsocksUsersForNode(storage, nodeId, owner);
    const second = buildShadowsocksUsersForNode(storage, nodeId, owner);
    expect(second).toEqual(first);
    expect(storage.listUsers("main", owner)[0]!.credentials.sskey).toBe(first.users[0]!.pass);
  });
});
