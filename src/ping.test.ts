import { describe, expect, test } from "bun:test";
import { parseNaiveParams, parseShadowsocksParams, parseTemplateEndpoint, parseVlessParams, templateKind } from "./ping";

describe("templateKind", () => {
  test("vless", () => expect(templateKind("vless://u@h:443#n")).toBe("vless"));
  test("naive", () => expect(templateKind("naive+https://u:p@h:443#n")).toBe("naive"));
  test("shadowsocks", () => expect(templateKind("ss://x@h:443#n")).toBe("shadowsocks"));
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
