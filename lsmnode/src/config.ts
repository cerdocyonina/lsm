import { readFileSync } from "node:fs";
import { XUIService } from "../../src/3x-ui";
import { CaddyBackend } from "./backends/caddy";
import { ShadowsocksBackend } from "./backends/shadowsocks";
import type { NodeBackend } from "./backends/types";
import { XuiBackend } from "./backends/xui";

export type BackendRegistry = {
  /** name → backend. Мастер адресует бэкенд первым сегментом пути: /<name>/sync-users. */
  backends: Map<string, NodeBackend>;
  /** Бэкенд для легаси-роутов без префикса (/sync-users вместо /naive/sync-users). */
  defaultName: string;
};

type Env = Record<string, string | undefined>;

function require(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Собирает один бэкенд из декларативного описания (одна запись backends.json). */
export function createBackendFromSpec(name: string, spec: Record<string, unknown>): NodeBackend {
  const kind = spec.kind;
  const str = (key: string): string => {
    const v = spec[key];
    if (typeof v !== "string" || !v) throw new Error(`backend "${name}": "${key}" must be a non-empty string`);
    return v;
  };
  const num = (key: string): number => {
    const v = spec[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`backend "${name}": "${key}" must be a number`);
    return v;
  };
  const optStr = (key: string): string | undefined => {
    const v = spec[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new Error(`backend "${name}": "${key}" must be a string`);
    return v;
  };

  switch (kind) {
    case "naive":
      return new CaddyBackend({ usersFile: str("usersFile"), container: str("container"), probeUrl: optStr("probeUrl") });
    case "shadowsocks":
      return new ShadowsocksBackend({
        configFile: str("configFile"),
        container: str("container"),
        method: str("method"),
        identityKey: str("identityKey"),
        port: num("port"),
        listen: optStr("listen"),
      });
    case "xui":
      return new XuiBackend(new XUIService({ host: str("host"), user: str("user"), password: str("password") }));
    default:
      throw new Error(`backend "${name}": unknown kind ${JSON.stringify(kind)}`);
  }
}

/** Легаси одно-бэкендовый режим (PROVIDER + kind-специфичные env), без backends.json. */
function buildLegacyBackend(env: Env): NodeBackend {
  const provider = (env.PROVIDER ?? "xui") as string;
  if (provider === "naive") {
    return new CaddyBackend({
      usersFile: require(env, "CADDY_USERS_FILE"),
      container: env.CADDY_CONTAINER ?? "naive",
      probeUrl: env.CADDY_PROBE_URL,
    });
  }
  if (provider === "xui") {
    return new XuiBackend(
      new XUIService({ host: require(env, "XUI_HOST"), user: require(env, "XUI_USER"), password: require(env, "XUI_PASSWORD") }),
    );
  }
  throw new Error(`PROVIDER must be "xui" or "naive", got "${provider}"`);
}

/**
 * Строит реестр бэкендов.
 *
 * Мультибэкенд-режим (BACKENDS_CONFIG=<путь к json>): один агент обслуживает несколько
 * провайдеров, каждый под своим именем-префиксом. Файл:
 *   { "default": "naive", "backends": { "naive": {kind, ...}, "ss2022": {kind, ...} } }
 *
 * Легаси-режим (без BACKENDS_CONFIG): единственный бэкенд из PROVIDER-env, смонтированный
 * под именем провайдера и назначенный default — существующие ноды продолжают работать
 * на неизменных unprefixed-роутах.
 */
export function buildBackends(env: Env): BackendRegistry {
  const configPath = env.BACKENDS_CONFIG;
  if (configPath) {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      default?: string;
      backends?: Record<string, Record<string, unknown>>;
    };
    const specs = raw.backends ?? {};
    const names = Object.keys(specs);
    if (names.length === 0) throw new Error(`${configPath}: "backends" must have at least one entry`);
    const backends = new Map<string, NodeBackend>();
    for (const name of names) backends.set(name, createBackendFromSpec(name, specs[name]!));
    const defaultName = raw.default ?? names[0]!;
    if (!backends.has(defaultName)) throw new Error(`${configPath}: default "${defaultName}" is not a defined backend`);
    return { backends, defaultName };
  }

  const provider = env.PROVIDER ?? "xui";
  const backend = buildLegacyBackend(env);
  return { backends: new Map([[provider, backend]]), defaultName: provider };
}
