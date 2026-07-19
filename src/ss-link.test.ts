import { describe, expect, test } from "bun:test";
import { encodeShadowsocksLink } from "./ss-link";

describe("encodeShadowsocksLink", () => {
  test("кодирует плоский userinfo в base64url, host и #tag не трогает", () => {
    const flat = "ss://2022-blake3-aes-128-gcm:IPSK==:USERPSK==@1.2.3.4:9444#SS-2022";
    const encoded = encodeShadowsocksLink(flat);
    const [, b64, tail] = encoded.match(/^ss:\/\/([^@]+)@(.+)$/)!;
    expect(tail).toBe("1.2.3.4:9444#SS-2022");
    expect(Buffer.from(b64!, "base64url").toString("utf8")).toBe(
      "2022-blake3-aes-128-gcm:IPSK==:USERPSK==",
    );
  });

  test("идемпотентно: повторный вызов уже-закодированной ссылки ничего не меняет", () => {
    const flat = "ss://2022-blake3-aes-128-gcm:IPSK==:USERPSK==@1.2.3.4:9444#SS-2022";
    const once = encodeShadowsocksLink(flat);
    expect(encodeShadowsocksLink(once)).toBe(once);
  });

  test("не-ss ссылки возвращаются как есть", () => {
    expect(encodeShadowsocksLink("vless://uuid@h:443#v")).toBe("vless://uuid@h:443#v");
    expect(encodeShadowsocksLink("naive+https://u:p@h:443#n")).toBe("naive+https://u:p@h:443#n");
  });

  test("ss без userinfo-двоеточия (уже статическая/закодированная) — без изменений", () => {
    expect(encodeShadowsocksLink("ss://YWJj@h:443#n")).toBe("ss://YWJj@h:443#n");
  });
});
