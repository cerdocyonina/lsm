import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowsocksBackend, renderXrayConfig, type ShadowsocksDeps } from "./shadowsocks";

const BASE: ShadowsocksDeps = {
  configFile: "/unused",
  container: "ss2022",
  method: "2022-blake3-aes-128-gcm",
  identityKey: "3oVfOeFFyS5o6LY3UoNxwg==",
  port: 9444,
};

describe("renderXrayConfig", () => {
  test("рендерит ss-2022 inbound с EIH-мультиюзером (iPSK в password, per-user в clients)", () => {
    const json = JSON.parse(
      renderXrayConfig(BASE, [
        { user: "main.alice", pass: "AAAAAAAAAAAAAAAAAAAAAA==" },
        { user: "par.bob", pass: "BBBBBBBBBBBBBBBBBBBBBB==" },
      ]),
    );
    const inbound = json.inbounds[0];
    expect(inbound.protocol).toBe("shadowsocks");
    expect(inbound.port).toBe(9444);
    expect(inbound.settings.method).toBe("2022-blake3-aes-128-gcm");
    expect(inbound.settings.password).toBe("3oVfOeFFyS5o6LY3UoNxwg=="); // identity PSK
    expect(inbound.settings.clients).toEqual([
      { password: "AAAAAAAAAAAAAAAAAAAAAA==", email: "main.alice" },
      { password: "BBBBBBBBBBBBBBBBBBBBBB==", email: "par.bob" },
    ]);
    expect(inbound.settings.network).toBe("tcp,udp");
  });

  test("пустой список = clients:[] (доступ закрыт), а не открытый inbound", () => {
    const json = JSON.parse(renderXrayConfig(BASE, []));
    expect(json.inbounds[0].settings.clients).toEqual([]);
  });

  test("кривая метка клиента отвергается целиком (полу-конфиг хуже отказа)", () => {
    expect(() => renderXrayConfig(BASE, [{ user: "has space", pass: "AAAAAAAAAAAAAAAAAAAAAA==" }])).toThrow();
  });

  test("не-base64 PSK отвергается", () => {
    expect(() => renderXrayConfig(BASE, [{ user: "main.alice", pass: "not_base64_url-style" }])).toThrow();
  });
});

describe("ShadowsocksBackend.syncUsers", () => {
  test("пишет конфиг и рестартит контейнер; synced = число юзеров", async () => {
    const configFile = join(tmpdir(), `ss-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const restarted: string[] = [];
    const backend = new ShadowsocksBackend({
      ...BASE,
      configFile,
      restart: async (c) => {
        restarted.push(c);
      },
    });
    try {
      const res = await backend.syncUsers([{ user: "main.alice", pass: "AAAAAAAAAAAAAAAAAAAAAA==" }]);
      expect(res).toEqual({ synced: 1 });
      expect(restarted).toEqual(["ss2022"]);
      const written = JSON.parse(readFileSync(configFile, "utf8"));
      expect(written.inbounds[0].settings.clients[0].email).toBe("main.alice");
    } finally {
      rmSync(configFile, { force: true });
    }
  });

  test("рестарт упал → конфиг записан, но error проброшен", async () => {
    const configFile = join(tmpdir(), `ss-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const backend = new ShadowsocksBackend({
      ...BASE,
      configFile,
      restart: async () => {
        throw new Error("docker down");
      },
    });
    try {
      const res = await backend.syncUsers([{ user: "main.alice", pass: "AAAAAAAAAAAAAAAAAAAAAA==" }]);
      expect(res.synced).toBe(1);
      expect(res.error).toContain("docker down");
      expect(readFileSync(configFile, "utf8")).toContain("main.alice");
    } finally {
      rmSync(configFile, { force: true });
    }
  });
});

describe("ShadowsocksBackend.health", () => {
  test("ok, когда порт слушается", async () => {
    const backend = new ShadowsocksBackend({ ...BASE, probe: async () => true });
    expect(await backend.health()).toEqual({ ok: true });
  });

  test("не ok, когда порта нет", async () => {
    const backend = new ShadowsocksBackend({ ...BASE, probe: async () => false });
    const status = await backend.health();
    expect(status.ok).toBe(false);
    expect(status.error).toContain("9444");
  });
});
