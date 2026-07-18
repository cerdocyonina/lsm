import { beforeEach, describe, expect, test } from "bun:test";
import { ensureUserCredentials, resolvedIdentityFor } from "./ensure-credentials";
import { SqliteStorage } from "./storage";

describe("ensureUserCredentials", () => {
  let storage: SqliteStorage;
  let owner: number;

  beforeEach(() => {
    storage = new SqliteStorage(":memory:", "admin");
    owner = storage.getPrimaryAdmin().id;
    storage.addUser("main", "alice", "tok-alice", "uuid-alice", 1000, owner);
  });

  function alice() {
    return storage.listUsers("main", owner)[0]!;
  }

  test("генерит недостающие креды и persist-ит их", () => {
    const creds = ensureUserCredentials(storage, alice(), ["user", "pass"]);
    expect(creds.user).toBe("alice");
    expect(creds.pass).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(alice().credentials).toEqual(creds);
  });

  test("идемпотентно — второй вызов не меняет пароль", () => {
    const first = ensureUserCredentials(storage, alice(), ["user", "pass"]);
    const second = ensureUserCredentials(storage, alice(), ["user", "pass"]);
    expect(second.pass).toBe(first.pass);
  });

  test("uuid не попадает в мешок — он живёт в user_uuid", () => {
    const creds = ensureUserCredentials(storage, alice(), ["uuid"]);
    expect(creds).toEqual({});
    expect(alice().credentials).toEqual({});
  });

  test("не пишет в БД, когда генерить нечего", () => {
    ensureUserCredentials(storage, alice(), ["pass"]);
    const before = alice().credentials.pass;
    ensureUserCredentials(storage, alice(), ["pass"]);
    expect(alice().credentials.pass).toBe(before);
  });
});

describe("resolvedIdentityFor", () => {
  test("uuid берётся из user_uuid и не перетирается мешком", () => {
    const user = {
      profileName: "main",
      ownerId: 1,
      clientName: "alice",
      subscriptionToken: "t",
      userUuid: "uuid-alice",
      credentials: { user: "alice", pass: "p1" },
      createdAt: 0,
    };
    expect(resolvedIdentityFor(user, user.credentials)).toEqual({
      user: "alice",
      pass: "p1",
      uuid: "uuid-alice",
    });
  });
});
