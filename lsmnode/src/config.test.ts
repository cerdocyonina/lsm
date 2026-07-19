import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBackends, createBackendFromSpec } from "./config";

describe("createBackendFromSpec", () => {
  test("naive → CaddyBackend (kind naive)", () => {
    const b = createBackendFromSpec("naive", { kind: "naive", usersFile: "/x", container: "naive" });
    expect(b.kind).toBe("naive");
  });

  test("shadowsocks → ShadowsocksBackend (kind shadowsocks)", () => {
    const b = createBackendFromSpec("ss2022", {
      kind: "shadowsocks",
      configFile: "/x/config.json",
      container: "ss2022",
      method: "2022-blake3-aes-128-gcm",
      identityKey: "3oVfOeFFyS5o6LY3UoNxwg==",
      port: 9444,
    });
    expect(b.kind).toBe("shadowsocks");
  });

  test("неизвестный kind — ошибка", () => {
    expect(() => createBackendFromSpec("x", { kind: "wireguard" })).toThrow(/unknown kind/);
  });

  test("отсутствие обязательного поля — ошибка", () => {
    expect(() => createBackendFromSpec("ss2022", { kind: "shadowsocks", container: "ss2022" })).toThrow();
  });
});

describe("buildBackends: legacy PROVIDER-режим", () => {
  test("PROVIDER=naive → один бэкенд под именем naive, он же default", () => {
    const { backends, defaultName } = buildBackends({
      PROVIDER: "naive",
      CADDY_USERS_FILE: "/x",
      CADDY_CONTAINER: "naive",
    });
    expect(defaultName).toBe("naive");
    expect([...backends.keys()]).toEqual(["naive"]);
    expect(backends.get("naive")!.kind).toBe("naive");
  });
});

describe("buildBackends: мультибэкенд через BACKENDS_CONFIG", () => {
  test("монтирует naive и ss2022, default читается из файла", () => {
    const path = join(tmpdir(), `backends-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        default: "naive",
        backends: {
          naive: { kind: "naive", usersFile: "/x", container: "naive" },
          ss2022: {
            kind: "shadowsocks",
            configFile: "/x/config.json",
            container: "ss2022",
            method: "2022-blake3-aes-128-gcm",
            identityKey: "3oVfOeFFyS5o6LY3UoNxwg==",
            port: 9444,
          },
        },
      }),
    );
    try {
      const { backends, defaultName } = buildBackends({ BACKENDS_CONFIG: path });
      expect(defaultName).toBe("naive");
      expect(new Set(backends.keys())).toEqual(new Set(["naive", "ss2022"]));
      expect(backends.get("ss2022")!.kind).toBe("shadowsocks");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("default, которого нет среди бэкендов, — ошибка", () => {
    const path = join(tmpdir(), `backends-bad-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({ default: "ghost", backends: { naive: { kind: "naive", usersFile: "/x", container: "naive" } } }),
    );
    try {
      expect(() => buildBackends({ BACKENDS_CONFIG: path })).toThrow(/default/);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
