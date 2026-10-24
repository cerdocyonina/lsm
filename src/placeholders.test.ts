import { describe, expect, test } from "bun:test";
import { applyServerPlaceholders, nodeHost, resolveTemplate, templateNeedsNode, templatePlaceholders } from "./placeholders";

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

  test("значение с подстрокой DUMMY не корёжится: подстановка в один проход", () => {
    expect(resolveTemplate("{pass}", { pass: "abcDUMMYxyz", uuid: "U1" })).toBe("abcDUMMYxyz");
  });

  test("имя клиента с DUMMY внутри сохраняется целиком", () => {
    expect(
      resolveTemplate("naive+https://{user}:{pass}@h#n", { user: "DUMMY-test", pass: "p", uuid: "U1" }),
    ).toBe("naive+https://DUMMY-test:p@h#n");
  });
});

describe("applyServerPlaceholders", () => {
  const node = { url: "http://191.217.211.141:9000/ss2022" };

  test("{ip} берётся из хоста URL ноды", () => {
    expect(applyServerPlaceholders("ss://m:K:{sskey}@{ip}:9444#n", node)).toBe("ss://m:K:{sskey}@191.217.211.141:9444#n");
  });

  test("юзерские плейсхолдеры и легаси DUMMY не трогает", () => {
    expect(applyServerPlaceholders("vless://DUMMY@{ip}:443?x={uuid}#{user}", node)).toBe(
      "vless://DUMMY@191.217.211.141:443?x={uuid}#{user}",
    );
  });

  test("без ноды {ip} схлопывается в пустую строку", () => {
    expect(applyServerPlaceholders("vless://{uuid}@{ip}:443#n", null)).toBe("vless://{uuid}@:443#n");
  });

  test("ключи прототипа ({constructor}) не считаются серверными", () => {
    expect(applyServerPlaceholders("{constructor}@{ip}", node)).toBe("{constructor}@191.217.211.141");
  });
});

describe("nodeHost", () => {
  test("IPv6 остаётся в скобках — годен для host:port", () => {
    expect(nodeHost("http://[2001:db8::1]:9000/naive")).toBe("[2001:db8::1]");
  });

  test("домен приводится к нижнему регистру", () => {
    expect(nodeHost("http://Node.Example.COM:9000")).toBe("node.example.com");
  });

  test("невалидный URL даёт пустую строку", () => {
    expect(nodeHost("not a url")).toBe("");
  });
});

describe("templateNeedsNode", () => {
  test("{ip} требует ноду, юзерские плейсхолдеры — нет", () => {
    expect(templateNeedsNode("ss://m:K:{sskey}@{ip}:9444#n")).toBe(true);
    expect(templateNeedsNode("ss://m:K:{sskey}@1.2.3.4:9444#n")).toBe(false);
  });
});
