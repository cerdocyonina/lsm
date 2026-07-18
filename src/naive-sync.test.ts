import { beforeEach, describe, expect, test } from "bun:test";
import { buildNaiveUsers } from "./naive-sync";
import { SqliteStorage } from "./storage";

describe("buildNaiveUsers", () => {
  let storage: SqliteStorage;
  let owner: number;

  beforeEach(() => {
    storage = new SqliteStorage(":memory:", "admin");
    owner = storage.getPrimaryAdmin().id;
  });

  test("собирает логин/пароль, генерируя недостающее", () => {
    storage.addUser("main", "alice", "tok-a", "uuid-a", 1000, owner);
    const { users, skipped } = buildNaiveUsers(storage, storage.listUsers("main", owner));
    expect(users).toHaveLength(1);
    expect(users[0]!.user).toBe("alice");
    expect(users[0]!.pass).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(skipped).toEqual([]);
  });

  test("креды persist-ятся — подписка отдаст тот же пароль", () => {
    storage.addUser("main", "alice", "tok-a", "uuid-a", 1000, owner);
    const generated = buildNaiveUsers(storage, storage.listUsers("main", owner)).users[0]!.pass;
    expect(storage.listUsers("main", owner)[0]!.credentials.pass).toBe(generated);
  });

  test("повторный вызов не меняет пароли", () => {
    storage.addUser("main", "alice", "tok-a", "uuid-a", 1000, owner);
    const first = buildNaiveUsers(storage, storage.listUsers("main", owner));
    const second = buildNaiveUsers(storage, storage.listUsers("main", owner));
    expect(second).toEqual(first);
  });

  test("несколько юзеров", () => {
    storage.addUser("main", "alice", "tok-a", "uuid-a", 1000, owner);
    storage.addUser("main", "bob", "tok-b", "uuid-b", 1001, owner);
    expect(buildNaiveUsers(storage, storage.listUsers("main", owner)).users.map((u) => u.user).sort())
      .toEqual(["alice", "bob"]);
  });

  test("пустой список юзеров — пустой результат", () => {
    expect(buildNaiveUsers(storage, [])).toEqual({ users: [], skipped: [] });
  });

  test("юзер с невалидным для Caddy именем пропускается и попадает в skipped", () => {
    storage.addUser("main", "bad name", "tok-bad", "uuid-bad", 1000, owner); // пробел
    const { users, skipped } = buildNaiveUsers(storage, storage.listUsers("main", owner));
    expect(users).toEqual([]);
    expect(skipped).toEqual(["bad name"]);
  });

  test("невалидное имя не роняет валидных: один skipped, остальные synced", () => {
    storage.addUser("main", "alice", "tok-a", "uuid-a", 1000, owner);
    storage.addUser("main", "has@at", "tok-at", "uuid-at", 1001, owner); // @ вне charset
    storage.addUser("main", "bob", "tok-b", "uuid-b", 1002, owner);
    const { users, skipped } = buildNaiveUsers(storage, storage.listUsers("main", owner));
    expect(users.map((u) => u.user).sort()).toEqual(["alice", "bob"]);
    expect(skipped).toEqual(["has@at"]);
  });
});
