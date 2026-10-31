import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MieruBackend, renderMitaConfig, validateBaseConfig, type CommandResult, type MitaBaseConfig } from "./mieru";

const BASE: MitaBaseConfig = {
  portBindings: [{ portRange: "8444-8453", protocol: "TCP" }],
  mtu: 1400,
};

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

/** Фейковый mita: пишет вызовы и (для replace) содержимое файла в момент вызова. */
function fakeMita(responses: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const files: string[] = [];
  const run = async (argv: string[]): Promise<CommandResult> => {
    calls.push(argv);
    if (argv[1] === "replace") files.push(readFileSync(argv[3]!, "utf8"));
    return responses[argv[1]!] ?? OK;
  };
  return { calls, files, run };
}

describe("validateBaseConfig", () => {
  test("принимает port или portRange с протоколом", () => {
    expect(() =>
      validateBaseConfig({ portBindings: [{ port: 8444, protocol: "TCP" }, { portRange: "9000-9010", protocol: "UDP" }] }),
    ).not.toThrow();
  });

  test("без portBindings — ошибка (mita без них не стартует)", () => {
    expect(() => validateBaseConfig({})).toThrow(/portBindings/);
    expect(() => validateBaseConfig({ portBindings: [] })).toThrow(/portBindings/);
  });

  test("users в базовом конфиге запрещены — их владелец lsm-node", () => {
    expect(() => validateBaseConfig({ ...BASE, users: [] })).toThrow(/users/);
  });

  test("port и portRange одновременно / ни одного — ошибка", () => {
    expect(() => validateBaseConfig({ portBindings: [{ port: 1, portRange: "1-2", protocol: "TCP" }] })).toThrow();
    expect(() => validateBaseConfig({ portBindings: [{ protocol: "TCP" }] })).toThrow();
  });

  test("кривой протокол — ошибка", () => {
    expect(() => validateBaseConfig({ portBindings: [{ port: 8444, protocol: "tcp" }] })).toThrow(/protocol/);
  });
});

describe("renderMitaConfig", () => {
  test("база + users {name,password}; остальные поля базы сохраняются", () => {
    const json = JSON.parse(
      renderMitaConfig(BASE, [
        { user: "main.alice", pass: "nvKH4m6a6jel8z3yb0nBb8" },
        { user: "par.bob", pass: "Zx_9-abcDEF" },
      ]),
    );
    expect(json.portBindings).toEqual([{ portRange: "8444-8453", protocol: "TCP" }]);
    expect(json.mtu).toBe(1400);
    expect(json.users).toEqual([
      { name: "main.alice", password: "nvKH4m6a6jel8z3yb0nBb8" },
      { name: "par.bob", password: "Zx_9-abcDEF" },
    ]);
  });

  test("пустой список = users:[] (mita никого не пускает)", () => {
    expect(JSON.parse(renderMitaConfig(BASE, [])).users).toEqual([]);
  });

  test("имя вне charset или длиннее 64 байт отвергается целиком", () => {
    expect(() => renderMitaConfig(BASE, [{ user: "has space", pass: "x" }])).toThrow();
    expect(() => renderMitaConfig(BASE, [{ user: "a".repeat(65), pass: "x" }])).toThrow();
  });

  test("пароль вне charset или длиннее 64 байт отвергается", () => {
    expect(() => renderMitaConfig(BASE, [{ user: "main.alice", pass: "a:b" }])).toThrow();
    expect(() => renderMitaConfig(BASE, [{ user: "main.alice", pass: "a".repeat(65) }])).toThrow();
  });
});

describe("MieruBackend.syncUsers", () => {
  test("replace config → reload → start; файл содержит полный конфиг; tmp убран", async () => {
    const mita = fakeMita();
    const backend = new MieruBackend({ baseConfig: BASE, run: mita.run });
    const res = await backend.syncUsers([{ user: "main.alice", pass: "nvKH4m6a6jel8z3yb0nBb8" }]);

    expect(res).toEqual({ synced: 1 });
    expect(mita.calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["mita replace config", "mita reload", "mita start"]);
    expect(JSON.parse(mita.files[0]!).users).toEqual([{ name: "main.alice", password: "nvKH4m6a6jel8z3yb0nBb8" }]);
    // Пароли не остаются на диске после синка.
    expect(() => readFileSync(mita.calls[0]![3]!, "utf8")).toThrow();
  });

  test("replace упал → исключение (конфиг не принят), reload не вызывается", async () => {
    const mita = fakeMita({ replace: { exitCode: 1, stdout: "", stderr: "ValidateFullServerConfig() failed: boom" } });
    const backend = new MieruBackend({ baseConfig: BASE, run: mita.run });
    await expect(backend.syncUsers([])).rejects.toThrow(/boom/);
    expect(mita.calls).toHaveLength(1);
  });

  test("reload упал → synced + error (конфиг сохранён, но не применён)", async () => {
    const mita = fakeMita({ reload: { exitCode: 1, stdout: "", stderr: "reload server listeners failed" } });
    const backend = new MieruBackend({ baseConfig: BASE, run: mita.run });
    const res = await backend.syncUsers([{ user: "main.alice", pass: "x" }]);
    expect(res.synced).toBe(1);
    expect(res.error).toContain("reload server listeners failed");
  });

  test("кастомный путь к бинарю", async () => {
    const mita = fakeMita();
    const backend = new MieruBackend({ baseConfig: BASE, mitaBin: "/usr/bin/mita", run: mita.run });
    await backend.syncUsers([]);
    expect(mita.calls[0]![0]).toBe("/usr/bin/mita");
  });
});

describe("MieruBackend.health", () => {
  test("RUNNING → ok", async () => {
    const mita = fakeMita({ status: { exitCode: 0, stdout: 'mita server status is "RUNNING"\n', stderr: "" } });
    expect(await new MieruBackend({ baseConfig: BASE, run: mita.run }).health()).toEqual({ ok: true });
  });

  test("IDLE → не ok, статус в ошибке", async () => {
    const mita = fakeMita({ status: { exitCode: 0, stdout: 'mita server status is "IDLE"\n', stderr: "" } });
    const status = await new MieruBackend({ baseConfig: BASE, run: mita.run }).health();
    expect(status.ok).toBe(false);
    expect(status.error).toContain("IDLE");
  });

  test("нет прав на сокет → не ok с подсказкой mita", async () => {
    const mita = fakeMita({
      status: { exitCode: 1, stdout: "", stderr: 'please retry after running "sudo usermod -a -G mita deploy"' },
    });
    const status = await new MieruBackend({ baseConfig: BASE, run: mita.run }).health();
    expect(status.ok).toBe(false);
    expect(status.error).toContain("usermod");
  });

  test("бинаря нет (spawn бросил) → не ok", async () => {
    const backend = new MieruBackend({
      baseConfig: BASE,
      run: async () => {
        throw new Error("Executable not found in $PATH: \"mita\"");
      },
    });
    const status = await backend.health();
    expect(status.ok).toBe(false);
    expect(status.error).toContain("mita");
  });
});
