import { describe, expect, test } from "bun:test";
import { buildHealthPayload } from "./health-payload";

describe("buildHealthPayload", () => {
  test("xui-нода отдаёт поле xui — контракт задеплоенных нод не меняется", () => {
    expect(buildHealthPayload("xui", { ok: true }, { version: "1.3.0" })).toEqual({
      ok: true,
      version: "1.3.0",
      xui: { ok: true },
    });
  });

  test("naive-нода отдаёт поле caddy", () => {
    expect(buildHealthPayload("naive", { ok: true }, { version: "1.3.0" })).toEqual({
      ok: true,
      version: "1.3.0",
      caddy: { ok: true },
    });
  });

  test("ошибка бэкенда прокидывается", () => {
    expect(buildHealthPayload("naive", { ok: false, error: "ECONNREFUSED" }, { version: "1.3.0" })).toEqual({
      ok: true,
      version: "1.3.0",
      caddy: { ok: false, error: "ECONNREFUSED" },
    });
  });

  test("нода жива, даже когда её провайдер лежит", () => {
    expect(buildHealthPayload("xui", { ok: false, error: "boom" }, { version: "1.3.0" }).ok).toBe(true);
  });

  test("commit и date прокидываются, когда есть", () => {
    expect(buildHealthPayload("xui", { ok: true }, { version: "1.3.0", commit: "abc1234", date: "2026-07-17" })).toEqual({
      ok: true,
      version: "1.3.0",
      commit: "abc1234",
      date: "2026-07-17",
      xui: { ok: true },
    });
  });

  test("поле error отсутствует, когда ошибки нет", () => {
    expect("error" in (buildHealthPayload("xui", { ok: true }, { version: "1.3.0" }).xui as object)).toBe(false);
  });
});
