import { describe, expect, test } from "bun:test";
import { XuiBackend } from "./xui";

/** Минимальный дубль XUIService — проверяем делегирование, а не саму панель. */
function fakeXui(overrides: Record<string, unknown> = {}) {
  return {
    ping: async () => ({ ok: true }),
    syncUser: async () => "added",
    checkConflicts: async () => [],
    deleteUser: async () => "deleted",
    ...overrides,
  } as any;
}

describe("XuiBackend", () => {
  test("kind = xui", () => {
    expect(new XuiBackend(fakeXui()).kind).toBe("xui");
  });

  test("health делегирует в ping", async () => {
    const backend = new XuiBackend(fakeXui({ ping: async () => ({ ok: false, error: "boom" }) }));
    expect(await backend.health()).toEqual({ ok: false, error: "boom" });
  });

  test("syncUser передаёт все аргументы в панель", async () => {
    const calls: unknown[][] = [];
    const backend = new XuiBackend(
      fakeXui({
        syncUser: async (...args: unknown[]) => {
          calls.push(args);
          return "added";
        },
      }),
    );
    expect(await backend.syncUser(7, "alice", "uuid-1", "overwrite")).toBe("added");
    expect(calls[0]).toEqual([7, "alice", "uuid-1", "overwrite"]);
  });

  test("deleteUser делегирует", async () => {
    expect(await new XuiBackend(fakeXui()).deleteUser("alice")).toBe("deleted");
  });

  test("checkConflicts делегирует", async () => {
    const backend = new XuiBackend(fakeXui({ checkConflicts: async () => ["bob"] }));
    expect(await backend.checkConflicts(["bob", "alice"])).toEqual(["bob"]);
  });

  test("syncUsers не поддерживается — это naive-путь", () => {
    expect(new XuiBackend(fakeXui()).syncUsers).toBeUndefined();
  });
});
