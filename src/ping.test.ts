import { describe, expect, test } from "bun:test";
import {
  buildMieruClientConfig,
  parseMieruLink,
  parseNaiveParams,
  parseShadowsocksClient,
  parseShadowsocksParams,
  parseTemplateEndpoint,
  parseVlessParams,
  templateKind,
} from "./ping";

describe("templateKind", () => {
  test("vless", () => expect(templateKind("vless://u@h:443#n")).toBe("vless"));
  test("naive", () => expect(templateKind("naive+https://u:p@h:443#n")).toBe("naive"));
  test("shadowsocks", () => expect(templateKind("ss://x@h:443#n")).toBe("shadowsocks"));
  test("mieru", () => expect(templateKind("mierus://u:p@h?profile=d&port=8444&protocol=TCP")).toBe("mieru"));
  test("прочее", () => expect(templateKind("trojan://x@h:443#n")).toBe("unknown"));
});

describe("parseShadowsocksParams", () => {
  test("берёт host:port после последнего @, userinfo с ':' не мешает", () => {
    expect(parseShadowsocksParams("ss://2022-blake3-aes-128-gcm:IPSK==:PSK==@1.2.3.4:9444#SS")).toEqual({
      host: "1.2.3.4",
      port: 9444,
    });
  });

  test("работает и с уже-закодированным (base64url) userinfo", () => {
    expect(parseShadowsocksParams("ss://YWJjZA@api.gregg.li:9444#SS")).toEqual({ host: "api.gregg.li", port: 9444 });
  });
});

describe("parseShadowsocksClient", () => {
  test("достаёт host/port/method/iPSK из плоского ss-шаблона (userPSK берётся отдельно)", () => {
    expect(parseShadowsocksClient("ss://2022-blake3-aes-128-gcm:IPSKvalue==:{sskey}@1.2.3.4:9444#SS")).toEqual({
      host: "1.2.3.4",
      port: 9444,
      method: "2022-blake3-aes-128-gcm",
      identityKey: "IPSKvalue==",
    });
  });

  test("userinfo без method:iPSK:psk (мало частей) — null", () => {
    expect(parseShadowsocksClient("ss://onlyone@1.2.3.4:9444#SS")).toBeNull();
  });
});

describe("parseNaiveParams", () => {
  test("вытаскивает host и port", () => {
    expect(parseNaiveParams("naive+https://alice:pw@api.gregg.li:443#hosfop")).toEqual({
      host: "api.gregg.li",
      port: 443,
    });
  });

  test("порт по умолчанию 443", () => {
    expect(parseNaiveParams("naive+https://alice:pw@api.gregg.li#hosfop")).toEqual({
      host: "api.gregg.li",
      port: 443,
    });
  });

  test("нестандартный порт", () => {
    expect(parseNaiveParams("naive+https://a:p@h.example:8443#n")?.port).toBe(8443);
  });

  test("мусор — null", () => {
    expect(parseNaiveParams("not a url")).toBeNull();
  });
});

describe("parseTemplateEndpoint", () => {
  test("работает для vless", () => {
    expect(parseTemplateEndpoint("vless://u@h.example:443?sni=x#n")).toEqual({ host: "h.example", port: 443 });
  });

  test("работает для naive", () => {
    expect(parseTemplateEndpoint("naive+https://u:p@h.example:443#n")).toEqual({ host: "h.example", port: 443 });
  });

  test("работает для shadowsocks", () => {
    expect(parseTemplateEndpoint("ss://2022-blake3-aes-128-gcm:IPSK==:PSK==@h.example:9444#n")).toEqual({
      host: "h.example",
      port: 9444,
    });
  });

  test("работает для mieru: начало диапазона портов, плейсхолдеры в userinfo не мешают", () => {
    expect(parseTemplateEndpoint("mierus://{user}:{mpass}@h.example?profile=d&port=8444-8453&protocol=TCP")).toEqual({
      host: "h.example",
      port: 8444,
    });
  });

  test("неизвестный тип — null", () => {
    expect(parseTemplateEndpoint("trojan://x@h:443#n")).toBeNull();
  });
});

describe("parseVlessParams (регресс)", () => {
  test("парсит reality-параметры как раньше", () => {
    const params = parseVlessParams("vless://DUMMY@1.2.3.4:443?sni=microsoft.com&pbk=KEY&sid=ab&fp=chrome#n");
    expect(params).toMatchObject({ host: "1.2.3.4", port: 443, sni: "microsoft.com", pbk: "KEY", sid: "ab", fp: "chrome" });
  });
});

describe("parseMieruLink", () => {
  test("разбирает простую ссылку: креды, хост, пары port/protocol, mtu и прочее", () => {
    expect(
      parseMieruLink(
        "mierus://main.alice:abc_DEF-1@1.2.3.4?profile=default&mtu=1400&multiplexing=MULTIPLEXING_LOW" +
          "&handshake-mode=HANDSHAKE_NO_WAIT&port=8444-8453&protocol=TCP&port=8460&protocol=UDP#tag",
      ),
    ).toEqual({
      host: "1.2.3.4",
      user: "main.alice",
      pass: "abc_DEF-1",
      bindings: [
        { portRange: "8444-8453", protocol: "TCP" },
        { port: 8460, protocol: "UDP" },
      ],
      mtu: 1400,
      multiplexing: "MULTIPLEXING_LOW",
      handshakeMode: "HANDSHAKE_NO_WAIT",
    });
  });

  test("IPv6 — без скобок, как ждёт клиентский конфиг", () => {
    expect(parseMieruLink("mierus://u:p@[2001:db8::1]?profile=d&port=8444&protocol=TCP")?.host).toBe("2001:db8::1");
  });

  test("число port и protocol не совпадает — null", () => {
    expect(parseMieruLink("mierus://u:p@h?profile=d&port=8444&port=8445&protocol=TCP")).toBeNull();
  });

  test("без портов, кривой протокол или диапазон — null", () => {
    expect(parseMieruLink("mierus://u:p@h?profile=d")).toBeNull();
    expect(parseMieruLink("mierus://u:p@h?profile=d&port=8444&protocol=tcp")).toBeNull();
    expect(parseMieruLink("mierus://u:p@h?profile=d&port=9000-8000&protocol=TCP")).toBeNull();
  });
});

describe("buildMieruClientConfig", () => {
  test("IP → ipAddress, RPC выключен, socks5 на заданном порту", () => {
    const cfg = buildMieruClientConfig(
      { host: "1.2.3.4", user: "main.alice", pass: "pw", bindings: [{ portRange: "8444-8453", protocol: "TCP" }] },
      40000,
    ) as { profiles: { user: unknown; servers: Record<string, unknown>[] }[]; rpcPort: number; socks5Port: number; activeProfile: string };
    expect(cfg.rpcPort).toBe(0);
    expect(cfg.socks5Port).toBe(40000);
    expect(cfg.activeProfile).toBe("lsm-ping");
    expect(cfg.profiles[0]!.user).toEqual({ name: "main.alice", password: "pw" });
    expect(cfg.profiles[0]!.servers[0]).toEqual({ ipAddress: "1.2.3.4", portBindings: [{ portRange: "8444-8453", protocol: "TCP" }] });
  });

  test("домен → domainName", () => {
    const cfg = buildMieruClientConfig(
      { host: "vpn.example.com", user: "u", pass: "p", bindings: [{ port: 8444, protocol: "TCP" }] },
      40000,
    ) as { profiles: { servers: Record<string, unknown>[] }[] };
    expect(cfg.profiles[0]!.servers[0]!.domainName).toBe("vpn.example.com");
    expect(cfg.profiles[0]!.servers[0]!.ipAddress).toBeUndefined();
  });
});
