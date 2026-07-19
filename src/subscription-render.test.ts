import { beforeEach, describe, expect, test } from "bun:test";
import { SqliteStorage } from "./storage";
import { renderSubscriptionLinks } from "./subscription";

/** Зовёт ТОТ ЖЕ конвейер, что и боевой src/index.ts — копии пайплайна тут быть не должно. */
function renderSubscription(storage: SqliteStorage, token: string): string[] {
  return renderSubscriptionLinks(storage, storage.getUserBySubscriptionToken(token)!);
}

describe("subscription render", () => {
  let storage: SqliteStorage;
  let owner: number;

  beforeEach(() => {
    storage = new SqliteStorage(":memory:", "admin");
    owner = storage.getPrimaryAdmin().id;
    storage.addUser("main", "alice", "tok", "uuid-alice", 1000, owner);
  });

  test("РЕГРЕСС: легаси vless-шаблон с DUMMY рендерится как раньше", () => {
    storage.addServer("main", "s1", "vless://DUMMY@h:443?fp=chrome#legacy", 1000, owner);
    expect(renderSubscription(storage, "tok")).toEqual(["vless://uuid-alice@h:443?fp=chrome#legacy"]);
  });

  test("naive-шаблон получает сгенерённые логин и пароль", () => {
    storage.addServer("main", "s1", "naive+https://{user}:{pass}@api.gregg.li:443#naive", 1000, owner);
    const [link] = renderSubscription(storage, "tok");
    expect(link).toMatch(/^naive\+https:\/\/main\.alice:[A-Za-z0-9_-]{22}@api\.gregg\.li:443#naive$/);
  });

  test("смешанный профиль: vless и naive в одной подписке", () => {
    storage.addServer("main", "vless-1", "vless://DUMMY@h:443#v", 1000, owner);
    storage.addServer("main", "naive-1", "naive+https://{user}:{pass}@h:443#n", 1001, owner);
    const links = renderSubscription(storage, "tok");
    expect(links).toHaveLength(2);
    expect(links[0]).toBe("vless://uuid-alice@h:443#v");
    expect(links[1]).toMatch(/^naive\+https:\/\/main\.alice:[A-Za-z0-9_-]{22}@h:443#n$/);
  });

  test("пароль стабилен между запросами подписки", () => {
    storage.addServer("main", "s1", "naive+https://{user}:{pass}@h:443#n", 1000, owner);
    expect(renderSubscription(storage, "tok")).toEqual(renderSubscription(storage, "tok"));
  });

  test("ss-2022 шаблон рендерится в SIP002: ss://base64url(method:iPSK:userPSK)@host#tag", () => {
    storage.addServer("main", "s1", "ss://2022-blake3-aes-128-gcm:IPSK==:{sskey}@1.2.3.4:9444#SS", 1000, owner);
    const [link] = renderSubscription(storage, "tok");
    const [, b64, tail] = link!.match(/^ss:\/\/([^@]+)@(.+)$/)!;
    expect(tail).toBe("1.2.3.4:9444#SS");
    const decoded = Buffer.from(b64!, "base64url").toString("utf8");
    expect(decoded).toMatch(/^2022-blake3-aes-128-gcm:IPSK==:[A-Za-z0-9+/]{22}==$/);
  });

  test("ss-пароль подписки совпадает с тем, что уйдёт на ноду (общий sskey)", () => {
    storage.addServer("main", "s1", "ss://2022-blake3-aes-128-gcm:IPSK==:{sskey}@h:9444#SS", 1000, owner);
    const [link] = renderSubscription(storage, "tok");
    const decoded = Buffer.from(link!.slice(5).split("@")[0]!, "base64url").toString("utf8");
    const userPsk = decoded.split(":")[2];
    expect(storage.listUsers("main", owner)[0]!.credentials.sskey).toBe(userPsk);
  });

  test("порядок ссылок следует sort_order", () => {
    storage.addServer("main", "a", "vless://DUMMY@a#a", 1000, owner);
    storage.addServer("main", "b", "vless://DUMMY@b#b", 1001, owner);
    storage.reorderServers("main", ["b", "a"], owner);
    expect(renderSubscription(storage, "tok")).toEqual(["vless://uuid-alice@b#b", "vless://uuid-alice@a#a"]);
  });
});
