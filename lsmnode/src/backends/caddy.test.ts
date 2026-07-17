import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaddyBackend, renderBasicAuthLines } from "./caddy";

const dirs: string[] = [];

async function tmpUsersFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "caddy-backend-"));
  dirs.push(dir);
  return join(dir, "naive-users.caddy");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("renderBasicAuthLines", () => {
  test("рендерит по строке на юзера", () => {
    expect(renderBasicAuthLines([{ user: "alice", pass: "p1" }, { user: "bob", pass: "p2" }]))
      .toBe("basic_auth alice p1\nbasic_auth bob p2\n");
  });

  test("пустой список — пустой файл (авторизацию держит статическая строка в Caddyfile)", () => {
    expect(renderBasicAuthLines([])).toBe("");
  });

  test("отвергает юзера с пробелом — иначе это инъекция директив в Caddyfile", () => {
    expect(() => renderBasicAuthLines([{ user: "a b", pass: "p" }])).toThrow(/invalid user/);
  });

  test("отвергает перевод строки в пароле", () => {
    expect(() => renderBasicAuthLines([{ user: "a", pass: "p\nbasic_auth evil x" }])).toThrow(/invalid password/);
  });

  test("отвергает пустой пароль", () => {
    expect(() => renderBasicAuthLines([{ user: "a", pass: "" }])).toThrow(/invalid password/);
  });

  test("принимает алфавит base64url и точки/дефисы в логине", () => {
    expect(renderBasicAuthLines([{ user: "a.b-c_d", pass: "aB3-_x" }])).toBe("basic_auth a.b-c_d aB3-_x\n");
  });
});

describe("CaddyBackend", () => {
  test("kind = naive", async () => {
    const backend = new CaddyBackend({ usersFile: await tmpUsersFile(), container: "naive", reload: async () => {} });
    expect(backend.kind).toBe("naive");
  });

  test("syncUsers пишет файл и релоадит", async () => {
    const usersFile = await tmpUsersFile();
    const reloaded: string[] = [];
    const backend = new CaddyBackend({
      usersFile,
      container: "naive",
      reload: async (c) => { reloaded.push(c); },
    });

    expect(await backend.syncUsers([{ user: "alice", pass: "p1" }])).toEqual({ synced: 1 });
    expect(await readFile(usersFile, "utf8")).toBe("basic_auth alice p1\n");
    expect(reloaded).toEqual(["naive"]);
  });

  test("полный список отзывает отсутствующих", async () => {
    const usersFile = await tmpUsersFile();
    const backend = new CaddyBackend({ usersFile, container: "naive", reload: async () => {} });

    await backend.syncUsers([{ user: "alice", pass: "p1" }, { user: "bob", pass: "p2" }]);
    await backend.syncUsers([{ user: "alice", pass: "p1" }]);

    expect(await readFile(usersFile, "utf8")).toBe("basic_auth alice p1\n");
  });

  test("ошибка reload возвращается, а не роняет ноду", async () => {
    const backend = new CaddyBackend({
      usersFile: await tmpUsersFile(),
      container: "naive",
      reload: async () => { throw new Error("reload boom"); },
    });
    const result = await backend.syncUsers([{ user: "alice", pass: "p1" }]);
    expect(result.synced).toBe(1);
    expect(result.error).toMatch(/reload boom/);
  });

  test("невалидный юзер отвергается ДО записи файла", async () => {
    const usersFile = await tmpUsersFile();
    const backend = new CaddyBackend({ usersFile, container: "naive", reload: async () => {} });

    // await обязателен: без него .rejects возвращает промис, тест проходит вхолостую.
    await expect(backend.syncUsers([{ user: "evil user", pass: "p" }])).rejects.toThrow(/invalid user/);
    await expect(readFile(usersFile, "utf8")).rejects.toThrow();
  });

  test("health: 200 от фасада = жив", async () => {
    const backend = new CaddyBackend({
      usersFile: await tmpUsersFile(),
      container: "naive",
      reload: async () => {},
      probe: async () => ({ status: 200 }),
    });
    expect(await backend.health()).toEqual({ ok: true });
  });

  test("health: не-200 = не жив", async () => {
    const backend = new CaddyBackend({
      usersFile: await tmpUsersFile(),
      container: "naive",
      reload: async () => {},
      probe: async () => ({ status: 502 }),
    });
    expect(await backend.health()).toEqual({ ok: false, error: "unexpected HTTP 502" });
  });

  test("health: сеть отвалилась = не жив с причиной", async () => {
    const backend = new CaddyBackend({
      usersFile: await tmpUsersFile(),
      container: "naive",
      reload: async () => {},
      probe: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(await backend.health()).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});
