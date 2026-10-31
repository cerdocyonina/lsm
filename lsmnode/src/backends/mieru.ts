import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthStatus, NaiveUser, NodeBackend } from "./types";

// Логин = <profile>.<clientName>, тот же charset, что у naive: он попадает в mierus://-ссылку
// как userinfo без percent-encoding, так что держим его URL-безопасным.
const LABEL_RE = /^[A-Za-z0-9._-]+$/;
// Пароль у нас base64url (randomSecret мастера) — тоже URL-безопасен как есть.
const PASS_RE = /^[A-Za-z0-9._-]+$/;
// Лимиты mita (apis/constant/user.go и ValidateServerConfigSingleUser).
const MAX_NAME_BYTES = 64;
const MAX_PASS_BYTES = 64;

export type MieruPortBinding = { port?: number; portRange?: string; protocol: "TCP" | "UDP" };

/** Минимальная форма серверного конфига mita, которую мы проверяем сами (остальное валидирует mita). */
export type MitaBaseConfig = { portBindings: MieruPortBinding[] } & Record<string, unknown>;

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

/**
 * Проверяет базовый конфиг из backends.json: portBindings обязательны (mita без них не стартует),
 * а users — наш, декларативный, и вручную задаваться не должен (иначе их молча затрёт синк).
 */
export function validateBaseConfig(base: unknown): MitaBaseConfig {
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    throw new Error("baseConfig must be an object");
  }
  const obj = base as Record<string, unknown>;
  if ("users" in obj) {
    throw new Error("baseConfig must not contain \"users\": lsm-node owns the user list");
  }
  const bindings = obj.portBindings;
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error("baseConfig.portBindings must be a non-empty array");
  }
  for (const b of bindings) {
    if (typeof b !== "object" || b === null) throw new Error("baseConfig.portBindings: entry must be an object");
    const { port, portRange, protocol } = b as Record<string, unknown>;
    if (protocol !== "TCP" && protocol !== "UDP") {
      throw new Error(`baseConfig.portBindings: protocol must be "TCP" or "UDP", got ${JSON.stringify(protocol)}`);
    }
    const hasPort = typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
    const hasRange = typeof portRange === "string" && /^\d+-\d+$/.test(portRange);
    if (hasPort === hasRange) {
      throw new Error("baseConfig.portBindings: each entry needs exactly one of port (1-65535) or portRange (\"A-B\")");
    }
  }
  return obj as MitaBaseConfig;
}

/**
 * Рендерит ПОЛНЫЙ серверный конфиг mita: базовый конфиг ноды + весь список юзеров.
 *
 * Применяется через `mita replace config` (не apply: apply мёржит users по имени и удалённый
 * юзер остался бы жить). Пустой список = users:[] — mita тогда никого не пускает, это
 * и есть «доступ закрыт» (в отличие от ss-2022, где пустой clients включает single-user режим).
 */
export function renderMitaConfig(base: MitaBaseConfig, users: NaiveUser[]): string {
  for (const { user, pass } of users) {
    if (!LABEL_RE.test(user) || Buffer.byteLength(user) > MAX_NAME_BYTES) {
      throw new Error(`invalid user ${JSON.stringify(user)}: expected ${LABEL_RE}, at most ${MAX_NAME_BYTES} bytes`);
    }
    if (!PASS_RE.test(pass) || Buffer.byteLength(pass) > MAX_PASS_BYTES) {
      throw new Error(`invalid password for user ${JSON.stringify(user)}: expected ${PASS_RE}, at most ${MAX_PASS_BYTES} bytes`);
    }
  }
  const config = { ...base, users: users.map(({ user, pass }) => ({ name: user, password: pass })) };
  return JSON.stringify(config, null, 2) + "\n";
}

async function spawnCommand(argv: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function describeFailure(argv: string[], res: CommandResult): string {
  const output = (res.stderr.trim() || res.stdout.trim()).split("\n").slice(-3).join(" | ");
  return `${argv.join(" ")} failed (exit ${res.exitCode})${output ? `: ${output}` : ""}`;
}

export type MieruDeps = {
  /** Всё, кроме users: portBindings (обязательно), mtu, trafficPattern, egress, ... — как в mita. */
  baseConfig: MitaBaseConfig;
  /** Путь к бинарю mita (по умолчанию "mita" из PATH). */
  mitaBin?: string;
  /** Инъекция для тестов; по умолчанию Bun.spawn. */
  run?: CommandRunner;
};

/**
 * Управляет юзерами mieru-сервера (mita). mita ставится нативно (deb/rpm + systemd), а управляется
 * через unix-сокет /var/run/mita/mita.sock — для этого юзер, под которым крутится lsm-node, должен
 * быть в группе mita (`sudo usermod -aG mita <user>` + перезапуск lsm-node).
 *
 * Декларативен, как Caddy и ss-2022, но применяется горячо: `mita replace config` сохраняет
 * конфиг, `mita reload` подменяет список юзеров (и listeners) без обрыва живых соединений.
 */
export class MieruBackend implements NodeBackend {
  public readonly kind = "mieru" as const;

  public constructor(private readonly deps: MieruDeps) {}

  private get mita(): string {
    return this.deps.mitaBin ?? "mita";
  }

  private async exec(args: string[]): Promise<CommandResult> {
    const run = this.deps.run ?? spawnCommand;
    return run([this.mita, ...args]);
  }

  public async health(): Promise<HealthStatus> {
    // mita status: "RUNNING" — слушает и обслуживает; "IDLE" — демон жив, но прокси не поднят
    // (например, нет portBindings/юзеров); ошибка — демон лежит или нет прав на сокет.
    try {
      const res = await this.exec(["status"]);
      const output = `${res.stdout}\n${res.stderr}`;
      // mita печатает статус в кавычках: `mita server status is "RUNNING"` / `... is "IDLE"`.
      if (res.exitCode === 0 && output.includes('"RUNNING"')) return { ok: true };
      return { ok: false, error: describeFailure([this.mita, "status"], res) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async syncUsers(users: NaiveUser[]): Promise<{ synced: number; error?: string }> {
    // Валидация до любых действий: полу-применённый конфиг хуже отказа.
    const content = renderMitaConfig(this.deps.baseConfig, users);

    // mita CLI читает файл сам (в процессе вызывающего), так что хватает приватного tmp:
    // пароли не остаются лежать на диске — копию mita хранит у себя в /etc/mita.
    const dir = await mkdtemp(join(tmpdir(), "lsm-mieru-"));
    const file = join(dir, "server.json");
    try {
      await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
      const replaced = await this.exec(["replace", "config", file]);
      if (replaced.exitCode !== 0) {
        // Конфиг не принят — mita живёт на прежнем, это ошибка запроса целиком.
        throw new Error(describeFailure([this.mita, "replace", "config"], replaced));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // reload горячо применяет конфиг к ЗАПУЩЕННОМУ прокси; в состоянии IDLE (свежая установка,
    // прокси ещё ни разу не стартовал) он ничего не делает — поэтому следом идемпотентный start:
    // при RUNNING это no-op, при IDLE он поднимает прокси уже с новым конфигом.
    for (const step of [["reload"], ["start"]]) {
      const res = await this.exec(step);
      if (res.exitCode !== 0) {
        // Конфиг сохранён, но в работу не пошёл (применится на следующем старте) — честно сообщаем.
        return { synced: users.length, error: describeFailure([this.mita, ...step], res) };
      }
    }
    return { synced: users.length };
  }
}
