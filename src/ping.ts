import { rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithConcurrency } from "./utils";

export type PingResult = {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
};

export type ServerIcmpResult = {
  serverName: string;
  host: string;
  port: number;
  icmp: PingResult;
};

export type ClientServerHttpResult = {
  serverName: string;
  result: PingResult;
};

export type ClientHttpPingResult = {
  clientName: string;
  userUuid: string;
  servers: ClientServerHttpResult[];
};

type VlessParams = {
  host: string;
  port: number;
  sni: string;
  fp: string;
  pbk: string;
  sid: string;
  spx: string;
  flow: string;
};

export function parseVlessParams(template: string): VlessParams | null {
  try {
    const url = new URL(template);
    const host = url.hostname;
    const port = parseInt(url.port, 10);
    if (!host || isNaN(port)) return null;

    const p = url.searchParams;
    return {
      host,
      port,
      sni: p.get("sni") ?? "",
      fp: p.get("fp") ?? "chrome",
      pbk: p.get("pbk") ?? "",
      sid: p.get("sid") ?? "",
      spx: p.get("spx") ?? "/",
      flow: p.get("flow") ?? "xtls-rprx-vision",
    };
  } catch {
    return null;
  }
}

export type NaiveParams = {
  host: string;
  port: number;
};

export function templateKind(template: string): "vless" | "naive" | "shadowsocks" | "unknown" {
  if (template.startsWith("vless://")) return "vless";
  if (template.startsWith("naive+https://")) return "naive";
  if (template.startsWith("ss://")) return "shadowsocks";
  return "unknown";
}

export function parseNaiveParams(template: string): NaiveParams | null {
  try {
    // naive+https://user:pass@host:port#name — strip the naive+ scheme prefix
    // so the standard URL parser can read it.
    const url = new URL(template.replace(/^naive\+/, ""));
    if (!url.hostname) return null;
    return { host: url.hostname, port: url.port ? parseInt(url.port, 10) : 443 };
  } catch {
    return null;
  }
}

/**
 * host/port из ss://-шаблона. Userinfo (method:iPSK:{sskey} или base64url) может содержать ':'
 * и '/', поэтому не полагаемся на URL-парсер: берём то, что после последнего '@', до '#'.
 */
export function parseShadowsocksParams(template: string): NaiveParams | null {
  const rest = template.slice("ss://".length);
  const at = rest.lastIndexOf("@");
  if (at === -1) return null;
  const hostPort = rest.slice(at + 1).split("#")[0]!;
  const colon = hostPort.lastIndexOf(":");
  if (colon === -1) return null;
  const host = hostPort.slice(0, colon);
  const port = parseInt(hostPort.slice(colon + 1), 10);
  if (!host || Number.isNaN(port)) return null;
  return { host, port };
}

/**
 * Разбирает ss-ШАБЛОН (плоский userinfo с плейсхолдером) на клиентские параметры:
 * host/port + метод + identity-PSK. Ждём форму "ss://<method>:<iPSK>:{sskey}@host:port#tag" —
 * ту, что хранится в БД (до base64-кодирования подписки). userPSK берётся из identity.sskey,
 * так что здесь только серверная часть.
 */
export function parseShadowsocksClient(
  template: string,
): { host: string; port: number; method: string; identityKey: string } | null {
  const endpoint = parseShadowsocksParams(template);
  if (!endpoint) return null;
  const rest = template.slice("ss://".length);
  const at = rest.lastIndexOf("@");
  const userinfo = rest.slice(0, at);
  const parts = userinfo.split(":");
  // Ожидаем ровно method:iPSK:<placeholder|psk>. base64/имя метода '@'/':' не содержат.
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  return { host: endpoint.host, port: endpoint.port, method: parts[0], identityKey: parts[1] };
}

/** host/port шаблона независимо от провайдера — для ICMP-пинга. */
export function parseTemplateEndpoint(template: string): NaiveParams | null {
  switch (templateKind(template)) {
    case "vless": {
      const params = parseVlessParams(template);
      return params ? { host: params.host, port: params.port } : null;
    }
    case "naive":
      return parseNaiveParams(template);
    case "shadowsocks":
      return parseShadowsocksParams(template);
    default:
      return null;
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      server.close((err) => {
        if (err || !port) reject(err ?? new Error("no port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for port"));
        return;
      }
      const sock = connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        setTimeout(attempt, 200);
      });
    }
    attempt();
  });
}

function checkToolOnPath(tool: string): boolean {
  return (
    Bun.spawnSync(["which", tool], { stdout: "pipe", stderr: "pipe" })
      .exitCode === 0
  );
}

export function checkHttpPingRequirements():
  | { ok: true }
  | { ok: false; error: string } {
  if (!checkToolOnPath("xray"))
    return { ok: false, error: "xray not found on PATH" };
  if (!checkToolOnPath("curl"))
    return { ok: false, error: "curl not found on PATH" };
  return { ok: true };
}

export async function pingIcmp(
  host: string,
  timeoutMs = 5000,
): Promise<PingResult> {
  const isMac = process.platform === "darwin";
  // macOS: -W in ms; Linux: -W in seconds
  const waitArg = isMac
    ? String(timeoutMs)
    : String(Math.ceil(timeoutMs / 1000));

  const start = Date.now();
  try {
    const proc = Bun.spawn(["ping", "-c", "1", "-W", waitArg, host], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const elapsed = Date.now() - start;

    if (exitCode !== 0) {
      return { ok: false, latencyMs: null, error: "host unreachable" };
    }

    const stdout = await new Response(proc.stdout).text();
    // macOS: "round-trip min/avg/max/stddev = 1.234/1.234/1.234/0.000 ms"
    // Linux:  "rtt min/avg/max/mdev = 1.234/1.234/1.234/0.000 ms"
    const match = stdout.match(/(?:rtt|round-trip)[^=]+=\s*([\d.]+)\/([\d.]+)/);
    const latencyMs = match ? parseFloat(match[2] ?? "0") : elapsed;

    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, latencyMs: null, error: (err as Error).message };
  }
}

const activePorts = new Set<number>();

async function getUniqueFreePort(): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const port = await findFreePort();
    if (!activePorts.has(port)) {
      activePorts.add(port);
      return port;
    }
  }
  throw new Error("failed to find a unique free port");
}

/** Разбирает "%{http_code} %{time_total}" от curl в PingResult (204 = ок). */
function curlProbeResult(output: string, elapsedMs: number): PingResult {
  const parts = output.trim().split(" ");
  const httpCode = parts[0];
  const timeSec = parseFloat(parts[1] ?? "0");
  if (httpCode === "204") {
    return { ok: true, latencyMs: isNaN(timeSec) ? elapsedMs : Math.round(timeSec * 1000) };
  }
  return {
    ok: false,
    latencyMs: null,
    error: httpCode === "000" ? "connection failed" : `unexpected HTTP ${httpCode}`,
  };
}

/**
 * Гоняет 204-пробу через локальный xray с заданным outbound (socks5 → curl).
 * Общий движок для vless и shadowsocks: различаются только outbound-настройки.
 */
async function pingThroughXray(outbound: unknown, timeoutMs: number): Promise<PingResult> {
  let socksPort: number;
  try {
    socksPort = await getUniqueFreePort();
  } catch {
    return { ok: false, latencyMs: null, error: "failed to find free port" };
  }

  const xrayConfig = {
    log: { loglevel: "none" },
    inbounds: [{ listen: "127.0.0.1", port: socksPort, protocol: "socks", settings: { udp: false } }],
    outbounds: [outbound],
  };
  const tmpFile = join(tmpdir(), `lsm-ping-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    await writeFile(tmpFile, JSON.stringify(xrayConfig));

    const xrayProc = Bun.spawn(["xray", "run", "-c", tmpFile], { stdout: "pipe", stderr: "pipe" });
    const portPromise = waitForPort(socksPort, 5000);
    const crashPromise = (async () => {
      const code = await xrayProc.exited;
      throw new Error(`xray crashed instantly with code ${code}`);
    })();

    try {
      await Promise.race([portPromise, crashPromise]);
    } catch (err) {
      xrayProc.kill();
      await xrayProc.exited;
      return { ok: false, latencyMs: null, error: (err as Error).message };
    }

    const curlTimeoutSec = Math.ceil(timeoutMs / 1000);
    const start = Date.now();
    const curlProc = Bun.spawn(
      [
        "curl", "--socks5-hostname", `127.0.0.1:${socksPort}`,
        "-o", "/dev/null", "-s", "-w", "%{http_code} %{time_total}",
        "--max-time", String(curlTimeoutSec),
        "http://www.google.com/generate_204",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const curlOutput = await new Response(curlProc.stdout).text();
    await curlProc.exited;
    const elapsed = Date.now() - start;

    xrayProc.kill();
    await xrayProc.exited;
    return curlProbeResult(curlOutput, elapsed);
  } catch (err) {
    return { ok: false, latencyMs: null, error: (err as Error).message };
  } finally {
    await rm(tmpFile, { force: true });
    activePorts.delete(socksPort);
  }
}

/**
 * Реальная per-user проверка naive: curl через сам CONNECT-прокси с basic_auth юзера.
 * 204 = и туннель, и креды рабочие. naive-бинарь на мастере не нужен — Caddy forward_proxy
 * принимает стандартный HTTPS-CONNECT, а curl умеет https-прокси (--proxy-user + -x https://).
 */
async function pingNaiveTunnel(
  params: NaiveParams,
  user: string,
  pass: string,
  timeoutMs: number,
): Promise<PingResult> {
  const curlTimeoutSec = Math.ceil(timeoutMs / 1000);
  const start = Date.now();
  const proc = Bun.spawn(
    [
      "curl", "-o", "/dev/null", "-s", "-w", "%{http_code} %{time_total}",
      "--max-time", String(curlTimeoutSec),
      "--proxy-user", `${user}:${pass}`,
      "-x", `https://${params.host}:${params.port}`,
      "https://www.google.com/generate_204",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return curlProbeResult(output, Date.now() - start);
}

/**
 * Per-user проверка соединения. identity — та же карта, что рендерит подписка
 * (resolvedIdentityFor): uuid для vless, {user}/{pass} для naive, {sskey} для ss.
 */
export async function pingHttp(
  template: string,
  identity: Record<string, string>,
  timeoutMs = 10000,
): Promise<PingResult> {
  const kind = templateKind(template);

  if (kind === "naive") {
    const naiveParams = parseNaiveParams(template);
    if (!naiveParams) return { ok: false, latencyMs: null, error: "failed to parse server template" };
    if (!identity.user || !identity.pass) {
      return { ok: false, latencyMs: null, error: "missing naive credentials" };
    }
    return pingNaiveTunnel(naiveParams, identity.user, identity.pass, timeoutMs);
  }

  if (kind === "shadowsocks") {
    const ss = parseShadowsocksClient(template);
    if (!ss) return { ok: false, latencyMs: null, error: "failed to parse server template" };
    if (!identity.sskey) return { ok: false, latencyMs: null, error: "missing shadowsocks key" };
    return pingThroughXray(
      {
        protocol: "shadowsocks",
        settings: {
          servers: [
            { address: ss.host, port: ss.port, method: ss.method, password: `${ss.identityKey}:${identity.sskey}` },
          ],
        },
      },
      timeoutMs,
    );
  }

  const params = parseVlessParams(template);
  if (!params) return { ok: false, latencyMs: null, error: "failed to parse server template" };
  return pingThroughXray(
    {
      protocol: "vless",
      settings: {
        vnext: [
          {
            address: params.host,
            port: params.port,
            users: [{ id: identity.uuid, flow: params.flow, encryption: "none" }],
          },
        ],
      },
      streamSettings: {
        network: "tcp",
        security: "reality",
        realitySettings: {
          serverName: params.sni,
          fingerprint: params.fp,
          publicKey: params.pbk,
          shortId: params.sid,
          spiderX: params.spx,
        },
      },
    },
    timeoutMs,
  );
}

export async function pingAllIcmp(
  servers: { name: string; template: string }[],
  timeoutMs = 5000,
  onProgress?: (done: number, total: number) => void,
): Promise<ServerIcmpResult[]> {
  const total = servers.length;
  let done = 0;
  return Promise.all(
    servers.map(async ({ name, template }) => {
      const endpoint = parseTemplateEndpoint(template);
      const host = endpoint?.host ?? "";
      const port = endpoint?.port ?? 0;
      const icmp = host
        ? await pingIcmp(host, timeoutMs)
        : { ok: false, latencyMs: null, error: "invalid template" };
      onProgress?.(++done, total);
      return { serverName: name, host, port, icmp };
    }),
  );
}

export async function pingAllHttp(
  servers: { name: string; template: string }[],
  users: { clientName: string; identity: Record<string, string> }[],
  timeoutMs = 10000,
  onProgress?: (done: number, total: number) => void,
): Promise<ClientHttpPingResult[]> {
  const pairs: { clientIdx: number; serverIdx: number }[] = [];
  for (let ci = 0; ci < users.length; ci++) {
    for (let si = 0; si < servers.length; si++) {
      pairs.push({ clientIdx: ci, serverIdx: si });
    }
  }

  const CONCURRENCY_LIMIT = 10;
  const total = pairs.length;
  let done = 0;

  const results = await runWithConcurrency(
    pairs,
    CONCURRENCY_LIMIT,
    async ({ clientIdx, serverIdx }) => {
      const result = await pingHttp(
        servers[serverIdx]!.template,
        users[clientIdx]!.identity,
        timeoutMs,
      );
      onProgress?.(++done, total);
      return result;
    },
  );

  return users.map((user, ci) => ({
    clientName: user.clientName,
    userUuid: user.identity.uuid ?? "",
    servers: servers.map((server, si) => ({
      serverName: server.name,
      result: results[ci * servers.length + si]!,
    })),
  }));
}
