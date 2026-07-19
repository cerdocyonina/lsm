import type { HealthStatus } from "./backends/types";

export type VersionInfo = { version: string; commit?: string; date?: string };

export type HealthPayload = {
  ok: true;
  version: string;
  commit?: string;
  date?: string;
  xui?: HealthStatus;
  caddy?: HealthStatus;
  shadowsocks?: HealthStatus;
};

/**
 * Имя под-статусного поля по виду бэкенда. Выбрано намеренно и стабильно: xui-ноды
 * в проде уже отдают "xui", naive — "caddy", и мастер читает именно их. Менять существующие
 * — значит требовать одновременного передеплоя всех нод.
 */
const HEALTH_FIELD: Record<"xui" | "naive" | "shadowsocks", "xui" | "caddy" | "shadowsocks"> = {
  xui: "xui",
  naive: "caddy",
  shadowsocks: "shadowsocks",
};

/**
 * ok:true означает «агент отвечает», а не «провайдер здоров» — под-статус лежит
 * в поле провайдера.
 */
export function buildHealthPayload(
  kind: "xui" | "naive" | "shadowsocks",
  status: HealthStatus,
  version: VersionInfo,
): HealthPayload {
  const subStatus: HealthStatus = { ok: status.ok, ...(status.error ? { error: status.error } : {}) };
  return {
    ok: true,
    ...version,
    [HEALTH_FIELD[kind]]: subStatus,
  };
}
