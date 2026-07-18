import type { HealthStatus } from "./backends/types";

export type VersionInfo = { version: string; commit?: string; date?: string };

export type HealthPayload = {
  ok: true;
  version: string;
  commit?: string;
  date?: string;
  xui?: HealthStatus;
  caddy?: HealthStatus;
};

/**
 * ok:true означает «агент отвечает», а не «провайдер здоров» — под-статус лежит
 * в поле провайдера.
 *
 * Имя поля выбирается по провайдеру намеренно: xui-ноды в проде уже отдают "xui",
 * и мастер это поле читает. Менять его — значит требовать одновременного передеплоя
 * всех нод.
 */
export function buildHealthPayload(
  kind: "xui" | "naive",
  status: HealthStatus,
  version: VersionInfo,
): HealthPayload {
  const subStatus: HealthStatus = { ok: status.ok, ...(status.error ? { error: status.error } : {}) };
  return {
    ok: true,
    ...version,
    [kind === "naive" ? "caddy" : "xui"]: subStatus,
  };
}
