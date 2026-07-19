import { mkdir, rename, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";
import type { HealthStatus, NaiveUser, NodeBackend } from "./types";

// clients[].email — это метка для логов/идентификации на сервере (сам EIH различает
// юзеров по PSK, а не по имени). Держим её в том же безопасном charset, что и naive-логин
// (<profile>.<clientName>), чтобы ничего не сломать в конфиге.
const LABEL_RE = /^[A-Za-z0-9._-]+$/;
// PSK — это стандартный base64 (Xray декодит его StdEncoding). 16 байт (aes-128) кодируются
// в 24 символа с "==" на конце; сюда же подходят и другие валидные длины ключей.
const PSK_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const DEFAULT_LISTEN = "0.0.0.0";
const DEFAULT_CONFIG_IN_CONTAINER = "/etc/xray/config.json";

type XrayClient = { password: string; email: string };

/**
 * Рендерит полный конфиг Xray под один shadowsocks-2022 inbound с EIH-мультиюзером.
 *
 * settings.password — это identity-PSK сервера (общий), а каждый клиент носит свой
 * personal-PSK в clients[].password. Клиент подключается паролем "<iPSK>:<userPSK>".
 * Пустой список клиентов = доступ закрыт для всех (декларативно, как и должно быть).
 */
export function renderXrayConfig(deps: ShadowsocksDeps, users: NaiveUser[]): string {
  for (const { user, pass } of users) {
    if (!LABEL_RE.test(user)) {
      throw new Error(`invalid client label ${JSON.stringify(user)}: expected ${LABEL_RE}`);
    }
    if (!PSK_RE.test(pass)) {
      throw new Error(`invalid PSK for client ${JSON.stringify(user)}: expected base64 ${PSK_RE}`);
    }
  }
  const clients: XrayClient[] = users.map(({ user, pass }) => ({ password: pass, email: user }));
  const config = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "ss2022",
        listen: deps.listen ?? DEFAULT_LISTEN,
        port: deps.port,
        protocol: "shadowsocks",
        settings: {
          method: deps.method,
          password: deps.identityKey,
          clients,
          network: "tcp,udp",
        },
      },
    ],
    outbounds: [{ protocol: "freedom" }],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

async function writeAtomic(path: string, content: string): Promise<void> {
  // Пишем в тот же каталог и rename-им: подмена файла атомарна, а поскольку в контейнер
  // прокинут КАТАЛОГ (а не одиночный файл), новый inode виден внутри без пересоздания
  // контейнера — иначе одиночный bind-mount застрял бы на старом inode.
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function dockerRestart(container: string): Promise<void> {
  // У Xray нет hot-reload конфига — применяем новый список юзеров рестартом контейнера.
  // Активные ss-стримы кратко рвутся, клиенты переподключаются сами.
  const proc = Bun.spawn(["docker", "restart", container], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new Error(`docker restart ${container} failed (exit ${exitCode}): ${stderr}`);
  }
}

function tcpProbe(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

export type ShadowsocksDeps = {
  /** Путь к config.json на хосте. Должен лежать ВНУТРИ каталога, прокинутого в контейнер. */
  configFile: string;
  /** Имя docker-контейнера с Xray, который рестартим для применения конфига. */
  container: string;
  /** Метод шифрования, напр. 2022-blake3-aes-128-gcm. */
  method: string;
  /** Identity-PSK сервера (inbound password), стандартный base64. */
  identityKey: string;
  port: number;
  listen?: string;
  configPathInContainer?: string;
  /** Инъекция для тестов; по умолчанию docker restart. */
  restart?: (container: string) => Promise<void>;
  /** Инъекция для тестов; по умолчанию TCP-connect на 127.0.0.1:port. */
  probe?: (port: number) => Promise<boolean>;
};

/**
 * Управляет юзерами Shadowsocks-2022 (Xray). Как и Caddy, декларативен: весь список
 * PSK-клиентов рендерится в конфиг разом и применяется рестартом контейнера
 * (per-user add у Xray-ss нет без gRPC-API — сознательно выбираем простой полный пуш).
 */
export class ShadowsocksBackend implements NodeBackend {
  public readonly kind = "shadowsocks" as const;

  public constructor(private readonly deps: ShadowsocksDeps) {}

  public async health(): Promise<HealthStatus> {
    const probe = this.deps.probe ?? tcpProbe;
    try {
      const up = await probe(this.deps.port);
      return up ? { ok: true } : { ok: false, error: `no listener on 127.0.0.1:${this.deps.port}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async syncUsers(users: NaiveUser[]): Promise<{ synced: number; error?: string }> {
    // Валидация до записи: полу-записанный конфиг хуже отказа.
    const content = renderXrayConfig(this.deps, users);
    await writeAtomic(this.deps.configFile, content);

    const restart = this.deps.restart ?? dockerRestart;
    try {
      await restart(this.deps.container);
    } catch (err) {
      // Конфиг записан, но Xray живёт на прежнем — честно сообщаем.
      return { synced: users.length, error: err instanceof Error ? err.message : String(err) };
    }
    return { synced: users.length };
  }
}
