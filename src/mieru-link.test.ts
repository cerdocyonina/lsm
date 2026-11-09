import { describe, expect, test } from "bun:test";
import { encodeMieruLink } from "./mieru-link";

const PROFILE = "%F0%9F%87%A9%F0%9F%87%AA%20DE%202%20%5BMieru%5D"; // "🇩🇪 DE 2 [Mieru]"

/** Как значение прочитает Go-клиент mieru (url.ParseQuery): '+' → пробел, %XX → байт. */
function goQueryValue(link: string, key: string): string | null {
  return new URL(link).searchParams.get(key);
}

describe("encodeMieruLink", () => {
  test("сырой profile с эмодзи, пробелами и скобками кодируется, остальное не меняется", () => {
    const raw = "mierus://main.alice:p4ss@1.2.3.4?profile=🇩🇪 DE 2 [Mieru]&port=8444-8453&protocol=TCP#🇩🇪 DE 2 [Mieru]";
    const encoded = encodeMieruLink(raw);
    expect(encoded).toBe(
      `mierus://main.alice:p4ss@1.2.3.4?profile=${PROFILE}&port=8444-8453&protocol=TCP#🇩🇪 DE 2 [Mieru]`,
    );
    expect(goQueryValue(encoded, "profile")).toBe("🇩🇪 DE 2 [Mieru]");
  });

  test("уже закодированное не кодируется второй раз (идемпотентно)", () => {
    const encoded = `mierus://u:p@h?profile=${PROFILE}&port=8444&protocol=TCP#t`;
    expect(encodeMieruLink(encoded)).toBe(encoded);
    const raw = "mierus://u:p@h?profile=DE 2&port=8444&protocol=TCP";
    expect(encodeMieruLink(encodeMieruLink(raw))).toBe(encodeMieruLink(raw));
  });

  test("экспорт mieru ('+' вместо пробела) сохраняет смысл: пробел → %20", () => {
    const exported = "mierus://u:p@h?profile=DE+2&port=8444&protocol=TCP";
    const encoded = encodeMieruLink(exported);
    expect(encoded).toBe("mierus://u:p@h?profile=DE%202&port=8444&protocol=TCP");
    expect(goQueryValue(encoded, "profile")).toBe(goQueryValue(exported, "profile"));
  });

  test("литеральный плюс пишется как %2B и доезжает до клиента плюсом", () => {
    const encoded = encodeMieruLink("mierus://u:p@h?profile=A%2BB&port=8444&protocol=TCP");
    expect(goQueryValue(encoded, "profile")).toBe("A+B");
  });

  test("'&' внутри имени (без \"ключ=\" следом) остаётся частью profile", () => {
    const encoded = encodeMieruLink("mierus://u:p@h?profile=DE & NL&port=8444&protocol=TCP");
    expect(encoded).toBe("mierus://u:p@h?profile=DE%20%26%20NL&port=8444&protocol=TCP");
    expect(goQueryValue(encoded, "profile")).toBe("DE & NL");
    expect(goQueryValue(encoded, "port")).toBe("8444");
  });

  test("одинокий '%' — значение сырое, кодируется целиком", () => {
    const encoded = encodeMieruLink("mierus://u:p@h?profile=100% fast&port=8444&protocol=TCP");
    expect(goQueryValue(encoded, "profile")).toBe("100% fast");
  });

  test("повторяющиеся port/protocol и порядок параметров сохраняются", () => {
    const link = "mierus://u:p@h?profile=d&port=8444-8453&protocol=TCP&port=8460&protocol=UDP#t";
    expect(encodeMieruLink(link)).toBe(link);
  });

  test("не-mieru ссылки и mieru без query возвращаются как есть", () => {
    expect(encodeMieruLink("vless://u@h:443?sni=a b#v")).toBe("vless://u@h:443?sni=a b#v");
    expect(encodeMieruLink("ss://x@h:1#a b")).toBe("ss://x@h:1#a b");
    expect(encodeMieruLink("mierus://u:p@h#t")).toBe("mierus://u:p@h#t");
  });
});
