import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_USERS_LABEL, ShadowsocksBackend, renderXrayConfig, type ShadowsocksDeps } from "./shadowsocks";

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

  test("an empty list keeps the inbound closed with one placeholder key nobody holds", () => {
    // clients: [] would make Xray run single-user on the identity PSK, which every link carries.
    const [first, second] = [renderXrayConfig(BASE, []), renderXrayConfig(BASE, [])].map(
      (c) => JSON.parse(c).inbounds[0].settings.clients,
    );
    expect(first).toHaveLength(1);
    expect(first[0].email).toBe(NO_USERS_LABEL);
    expect(first[0].password).not.toBe(BASE.identityKey);
    expect(Buffer.from(first[0].password, "base64")).toHaveLength(16); // aes-128 key size
    expect(second[0].password).not.toBe(first[0].password); // fresh every time
    const aes256 = JSON.parse(
      renderXrayConfig({ ...BASE, method: "2022-blake3-aes-256-gcm", identityKey: Buffer.alloc(32, 1).toString("base64") }, []),
    );
    expect(Buffer.from(aes256.inbounds[0].settings.clients[0].password, "base64")).toHaveLength(32);
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
