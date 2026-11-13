import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildDeclarativeUsers,
  buildMieruUsersForNode,
  buildNaiveUsersForNode,
  buildShadowsocksUsersForNode,
  buildXrayUsersForNode,
} from "./naive-sync";
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

  test("profiles: разбивка по профилям — только профили с сервером на ноде, без пропущенных юзеров", () => {
    const other = storage.addNode("solo", "http://y:9000", "sek", 0, owner, 0, "naive").id;
    storage.addServer("main", "s-main", NAIVE, 0, owner, nodeId);
    storage.addServer("par", "s-par", NAIVE, 0, owner, nodeId);
    storage.addServer("pul", "s-pul", NAIVE, 0, owner, other);
    storage.addUser("main", "alice", "t1", "u1", 1000, owner);
    storage.addUser("main", "bad@name", "t2", "u2", 1001, owner); // невалидный логин → skipped
    storage.addUser("par", "bob", "t3", "u3", 1002, owner);
    storage.addUser("par", "carol", "t4", "u4", 1003, owner);
    storage.addUser("pul", "dave", "t5", "u5", 1004, owner);

    const { users, skipped, profiles } = buildNaiveUsersForNode(storage, nodeId, owner);
    // Порядок — как у listProfiles (порядок профилей в панели), поэтому сравниваем без него.
    expect([...profiles].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "main", users: 1 },
      { name: "par", users: 2 },
    ]);
    expect(profiles.reduce((sum, p) => sum + p.users, 0)).toBe(users.length);
    expect(skipped).toEqual(["main/bad@name"]);
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
    expect(buildNaiveUsersForNode(storage, nodeId, owner)).toEqual({ users: [], skipped: [], profiles: [] });
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

const MIERU = "mierus://{user}:{mpass}@h?profile=default&port=8444-8453&protocol=TCP";

describe("buildMieruUsersForNode", () => {
  let storage: SqliteStorage;
  let owner: number;
  let nodeId: number;

  beforeEach(() => {
    storage = new SqliteStorage(":memory:", "admin");
    owner = storage.getPrimaryAdmin().id;
    storage.createProfile("par", owner, 0);
    nodeId = storage.addNode("hosfop", "http://x:9000/mieru", "sek", 0, owner, 0, "mieru").id;
  });

  test("логин namespace-нут профилем; пароль — отдельный кред mpass, не naive-шный pass", () => {
    storage.addServer("main", "s-mieru", MIERU, 0, owner, nodeId);
    storage.addServer("main", "s-naive", NAIVE, 1, owner, null);
    storage.addUser("main", "alice", "t1", "u1", 1000, owner);
    // naive-пароль появляется в мешке при рендере naive-сервера — эмулируем это заранее.
    storage.setUserCredentials("main", "alice", { pass: "naivePass123" }, owner);

    const { users, skipped } = buildMieruUsersForNode(storage, nodeId, owner);
    expect(skipped).toEqual([]);
    expect(users).toHaveLength(1);
    expect(users[0]!.user).toBe("main.alice");
    expect(users[0]!.pass).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(users[0]!.pass).not.toBe("naivePass123");
    const creds = storage.listUsers("main", owner)[0]!.credentials;
    expect(creds.mpass).toBe(users[0]!.pass);
    expect(creds.pass).toBe("naivePass123");
  });

  test("одинаковый clientName в двух профилях → логины различны, пароли разные", () => {
    storage.addServer("main", "s-main", MIERU, 0, owner, nodeId);
    storage.addServer("par", "s-par", MIERU, 0, owner, nodeId);
    storage.addUser("main", "client1", "t1", "u1", 1000, owner);
    storage.addUser("par", "client1", "t2", "u2", 1001, owner);

    const byLabel = Object.fromEntries(buildMieruUsersForNode(storage, nodeId, owner).users.map((u) => [u.user, u.pass]));
    expect(Object.keys(byLabel).sort()).toEqual(["main.client1", "par.client1"]);
    expect(byLabel["main.client1"]).not.toBe(byLabel["par.client1"]);
  });

  test("невалидное имя пропускается, а не роняет синк всей ноды", () => {
    storage.addServer("main", "s-main", MIERU, 0, owner, nodeId);
    storage.addUser("main", "ok", "t1", "u1", 1000, owner);
    storage.addUser("main", "bad name", "t2", "u2", 1001, owner);

    const { users, skipped } = buildMieruUsersForNode(storage, nodeId, owner);
    expect(users.map((u) => u.user)).toEqual(["main.ok"]);
    expect(skipped).toEqual(["main/bad name"]);
  });
});

describe("buildXrayUsersForNode", () => {
  const VLESS = "vless://{uuid}@{ip}:443?type=tcp&security=reality#x";
  let storage: SqliteStorage;
  let owner: number;
  let nodeId: number;

  beforeEach(() => {
    storage = new SqliteStorage(":memory:", "admin");
    owner = storage.getPrimaryAdmin().id;
    storage.createProfile("par", owner, 0);
    nodeId = storage.addNode("atofop", "http://x:9000/vless", "sek", 0, owner, 0, "xray").id;
  });

  test("email namespaced by profile, the secret is the user's own UUID (no new credential)", () => {
    storage.addServer("main", "s-main", VLESS, 0, owner, nodeId);
    storage.addServer("par", "s-par", VLESS, 0, owner, nodeId);
    storage.addUser("main", "client1", "t1", "11111111-2222-4333-8444-555555555555", 1000, owner);
    storage.addUser("par", "client1", "t2", "66666666-7777-4888-9999-aaaaaaaaaaaa", 1001, owner);

    const { users, skipped } = buildXrayUsersForNode(storage, nodeId, owner);
    expect(skipped).toEqual([]);
    expect([...users].sort((a, b) => a.user.localeCompare(b.user))).toEqual([
      { user: "main.client1", pass: "11111111-2222-4333-8444-555555555555" },
      { user: "par.client1", pass: "66666666-7777-4888-9999-aaaaaaaaaaaa" },
    ]);
    expect(storage.listUsers("main", owner)[0]!.credentials).toEqual({});
  });

  test("a malformed UUID is skipped and reported, not pushed", () => {
    storage.addServer("main", "s-main", VLESS, 0, owner, nodeId);
    storage.addUser("main", "ok", "t1", "11111111-2222-4333-8444-555555555555", 1000, owner);
    storage.addUser("main", "legacy", "t2", "not-a-uuid", 1001, owner);
    const { users, skipped } = buildXrayUsersForNode(storage, nodeId, owner);
    expect(users.map((u) => u.user)).toEqual(["main.ok"]);
    expect(skipped).toEqual(["main/legacy"]);
  });

  test("buildDeclarativeUsers dispatches an xray node to the UUID list", () => {
    storage.addServer("main", "s-main", VLESS, 0, owner, nodeId);
    storage.addUser("main", "alice", "t1", "11111111-2222-4333-8444-555555555555", 1000, owner);
    const node = storage.getNode(nodeId, owner)!;
    expect(buildDeclarativeUsers(storage, node, owner).users).toEqual([
      { user: "main.alice", pass: "11111111-2222-4333-8444-555555555555" },
    ]);
  });
});
