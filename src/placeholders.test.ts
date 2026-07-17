import { describe, expect, test } from "bun:test";
import { resolveTemplate, templatePlaceholders } from "./placeholders";

describe("templatePlaceholders", () => {
  test("находит именованные плейсхолдеры", () => {
    expect(templatePlaceholders("naive+https://{user}:{pass}@h:443#n").sort()).toEqual(["pass", "user"]);
  });

  test("легаси DUMMY даёт uuid", () => {
    expect(templatePlaceholders("vless://DUMMY@h:443?x=1#n")).toEqual(["uuid"]);
  });

  test("дедуплицирует повторы", () => {
    expect(templatePlaceholders("{user}-{user}-{pass}").sort()).toEqual(["pass", "user"]);
  });

  test("без плейсхолдеров — пусто", () => {
    expect(templatePlaceholders("ss://static@h:443#n")).toEqual([]);
  });
});

describe("resolveTemplate", () => {
  test("подставляет именованные плейсхолдеры", () => {
    expect(resolveTemplate("naive+https://{user}:{pass}@h:443#n", { user: "alice", pass: "s3cret" }))
      .toBe("naive+https://alice:s3cret@h:443#n");
  });

  test("легаси DUMMY получает uuid", () => {
    expect(resolveTemplate("vless://DUMMY@h:443#n", { uuid: "u-1" })).toBe("vless://u-1@h:443#n");
  });

  test("DUMMY и {uuid} эквивалентны", () => {
    const creds = { uuid: "u-1" };
    expect(resolveTemplate("vless://DUMMY@h#n", creds)).toBe(resolveTemplate("vless://{uuid}@h#n", creds));
  });

  test("отсутствующий ключ схлопывается в пустую строку", () => {
    expect(resolveTemplate("a{missing}b", {})).toBe("ab");
  });

  test("заменяет все вхождения", () => {
    expect(resolveTemplate("{user}/{user}", { user: "x" })).toBe("x/x");
    expect(resolveTemplate("DUMMY-DUMMY", { uuid: "u" })).toBe("u-u");
  });
});
