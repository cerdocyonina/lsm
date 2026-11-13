import { describe, expect, test } from "bun:test";
import { labelOf, withLabel, withoutLabel } from "./link-label";
import { encodeMieruLink } from "./mieru-link";

const MIERU = "mierus://{user}:{mpass}@{ip}?profile=🇩🇪 DE 1 [Mieru]&port=8444-8453&protocol=TCP#vyrfop-mieru";

describe("link labels", () => {
  test("ordinary links use the #fragment", () => {
    const vless = "vless://{uuid}@{ip}:443?type=tcp#🇩🇪 DE 0";
    expect(labelOf(vless)).toBe("🇩🇪 DE 0");
    expect(withLabel(vless, "DE 0 (main)")).toBe("vless://{uuid}@{ip}:443?type=tcp#DE%200%20(main)");
    expect(labelOf("vless://x@h:1")).toBeNull();
    expect(withLabel("vless://x@h:1", "A")).toBe("vless://x@h:1#A");
  });

  test("mieru uses profile= and leaves # alone", () => {
    expect(labelOf(MIERU)).toBe("🇩🇪 DE 1 [Mieru]");
    const relabelled = withLabel(MIERU, "DE 1 & co");
    expect(labelOf(relabelled)).toBe("DE 1 & co");
    expect(relabelled).toEndWith("&port=8444-8453&protocol=TCP#vyrfop-mieru");
    // The subscription encoder keeps the override intact.
    expect(encodeMieruLink(relabelled)).toContain("?profile=DE%201%20%26%20co&port=");
    expect(labelOf("mierus://u:p@h?profile=A+B%2BC&port=1")).toBe("A B+C");
  });

  test("mieru without profile= falls back to the fragment", () => {
    expect(labelOf("mierus://u:p@h?port=1#Name")).toBe("Name");
  });

  test("withoutLabel makes label-only variants equal", () => {
    expect(withoutLabel(MIERU)).toBe(withoutLabel(withLabel(MIERU, "other")));
    expect(withoutLabel("vless://a#X")).toBe(withoutLabel("vless://a#Y"));
    expect(withoutLabel(MIERU)).not.toBe(withoutLabel(MIERU.replace("#vyrfop-mieru", "#x")));
  });
});
