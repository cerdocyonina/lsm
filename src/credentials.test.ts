import { describe, expect, test } from "bun:test";
import { generateCredential, missingCredentialKeys } from "./credentials";

describe("generateCredential", () => {
  test("ключ user — это имя клиента (человекочитаемо)", () => {
    expect(generateCredential("user", "alice")).toBe("alice");
  });

  test("ключ pass — 22 символа base64url", () => {
    expect(generateCredential("pass", "alice")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("pass случаен между вызовами", () => {
    expect(generateCredential("pass", "alice")).not.toBe(generateCredential("pass", "alice"));
  });

  test("неизвестный ключ — тоже случайный секрет", () => {
    expect(generateCredential("token", "alice")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("missingCredentialKeys", () => {
  test("возвращает только отсутствующие", () => {
    expect(missingCredentialKeys(["user", "pass"], { user: "alice" })).toEqual(["pass"]);
  });

  test("uuid игнорируется — он живёт в колонке user_uuid, а не в мешке", () => {
    expect(missingCredentialKeys(["uuid", "pass"], {})).toEqual(["pass"]);
  });

  test("пустая строка считается отсутствующей", () => {
    expect(missingCredentialKeys(["pass"], { pass: "" })).toEqual(["pass"]);
  });

  test("всё на месте — пусто", () => {
    expect(missingCredentialKeys(["user", "pass"], { user: "a", pass: "b" })).toEqual([]);
  });
});
