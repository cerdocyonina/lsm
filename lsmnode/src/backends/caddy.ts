import { rename, writeFile } from "node:fs/promises";
import type { HealthStatus, NaiveUser, NodeBackend } from "./types";

// Caddyfile — это язык директив, разделённых пробелами и переводами строк.
// Всё, что попадает в basic_auth, обязано быть одним токеном, иначе логин или
// пароль может внести в конфиг новую директиву.
const USER_RE = /^[A-Za-z0-9._-]+$/;
const PASS_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Рендерит управляемый блок basic_auth-строк.
 *
 * Пустой список даёт пустой файл — это нормально: авторизацию продолжает держать
 * статическая строка basic_auth в основном Caddyfile. forward_proxy без единого
 * basic_auth стал бы открытым прокси, поэтому ту строку удалять нельзя.
 */
export function renderBasicAuthLines(users: NaiveUser[]): string {
  for (const { user, pass } of users) {
    if (!USER_RE.test(user)) {
      throw new Error(`invalid user ${JSON.stringify(user)}: expected ${USER_RE}`);
    }
    if (!PASS_RE.test(pass)) {
      throw new Error(`invalid password for user ${JSON.stringify(user)}: expected ${PASS_RE}`);
    }
  }
  if (users.length === 0) return "";
  return users.map(({ user, pass }) => `basic_auth ${user} ${pass}`).join("\n") + "\n";
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function dockerReload(container: string): Promise<void> {
  const proc = Bun.spawn(
    ["docker", "exec", container, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new Error(`caddy reload failed (exit ${exitCode}): ${stderr}`);
  }
}

const DEFAULT_PROBE_URL = "https://127.0.0.1/";

async function httpsProbe(url: string): Promise<{ status: number }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(3000),
    redirect: "manual",
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  return { status: response.status };
}

export type CaddyDeps = {
  usersFile: string;
  container: string;
  /**
   * URL для health-проверки фасада. По умолчанию https://127.0.0.1/. Но если у Caddy
   * включён probe_resistance, он рвёт TLS-хендшейк без правильного SNI (это его задача —
   * прятаться от активного зондирования), и проба по голому IP не проходит. Тогда укажи
   * хостнейм (https://<домен>/), а сам домен пропиши на loopback в /etc/hosts —
   * получишь и правильный SNI, и чистый loopback без выхода в интернет.
   */
  probeUrl?: string;
  /** Инъекция для тестов; по умолчанию docker exec caddy reload. */
  reload?: (container: string) => Promise<void>;
  /** Инъекция для тестов; по умолчанию HTTPS-GET на probeUrl. */
  probe?: () => Promise<{ status: number }>;
};

/**
 * Управляет юзерами NaïveProxy. В отличие от 3x-ui, у Caddy нет management-API:
 * юзеры — это строки конфига, поэтому синк декларативный (весь список разом),
 * а не per-user.
 */
export class CaddyBackend implements NodeBackend {
  public readonly kind = "naive" as const;

  public constructor(private readonly deps: CaddyDeps) {}

  public async health(): Promise<HealthStatus> {
    const probeUrl = this.deps.probeUrl ?? DEFAULT_PROBE_URL;
    const probe = this.deps.probe ?? (() => httpsProbe(probeUrl));
    try {
      const { status } = await probe();
      if (status === 200) return { ok: true };
      return { ok: false, error: `unexpected HTTP ${status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async syncUsers(users: NaiveUser[]): Promise<{ synced: number; error?: string }> {
    // Валидация до записи: полу-записанный конфиг хуже, чем отказ.
    const content = renderBasicAuthLines(users);
    await writeAtomic(this.deps.usersFile, content);

    const reload = this.deps.reload ?? dockerReload;
    try {
      await reload(this.deps.container);
    } catch (err) {
      // Файл записан, но Caddy живёт на прежнем конфиге — честно сообщаем.
      return { synced: users.length, error: err instanceof Error ? err.message : String(err) };
    }
    return { synced: users.length };
  }
}
