import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";

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
  return Bun.spawnSync(["which", tool], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

export function checkHttpPingRequirements(): { ok: true } | { ok: false; error: string } {
  if (!checkToolOnPath("xray")) return { ok: false, error: "xray not found on PATH" };
  if (!checkToolOnPath("curl")) return { ok: false, error: "curl not found on PATH" };
  return { ok: true };
}

export async function pingIcmp(host: string, timeoutMs = 5000): Promise<PingResult> {
  const isMac = process.platform === "darwin";
  // macOS: -W in ms; Linux: -W in seconds
  const waitArg = isMac ? String(timeoutMs) : String(Math.ceil(timeoutMs / 1000));

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

export async function pingHttp(
  template: string,
  userUuid: string,
  timeoutMs = 10000,
): Promise<PingResult> {
  const params = parseVlessParams(template);
  if (!params) {
    return { ok: false, latencyMs: null, error: "failed to parse server template" };
  }

  let socksPort: number;
  try {
    socksPort = await findFreePort();
  } catch {
    return { ok: false, latencyMs: null, error: "failed to find free port" };
  }

  const xrayConfig = {
    log: { loglevel: "none" },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: socksPort,
        protocol: "socks",
        settings: { udp: false },
      },
    ],
    outbounds: [
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: params.host,
              port: params.port,
              users: [{ id: userUuid, flow: params.flow, encryption: "none" }],
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
    ],
  };

  const tmpFile = join(
    tmpdir(),
    `lsm-ping-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  try {
    await writeFile(tmpFile, JSON.stringify(xrayConfig));

    const xrayProc = Bun.spawn(["xray", "run", "-c", tmpFile], {
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await waitForPort(socksPort, 5000);
    } catch {
      xrayProc.kill();
      await xrayProc.exited;
      return { ok: false, latencyMs: null, error: "xray failed to start" };
    }

    const curlTimeoutSec = Math.ceil(timeoutMs / 1000);
    const start = Date.now();
    const curlProc = Bun.spawn(
      [
        "curl",
        "--socks5-hostname",
        `127.0.0.1:${socksPort}`,
        "-o",
        "/dev/null",
        "-s",
        "-w",
        "%{http_code} %{time_total}",
        "--max-time",
        String(curlTimeoutSec),
        "http://www.google.com/generate_204",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const curlOutput = await new Response(curlProc.stdout).text();
    await curlProc.exited;
    const elapsed = Date.now() - start;

    xrayProc.kill();
    await xrayProc.exited;

    const parts = curlOutput.trim().split(" ");
    const httpCode = parts[0];
    const timeSec = parseFloat(parts[1] ?? "0");

    if (httpCode === "204") {
      const latencyMs = isNaN(timeSec) ? elapsed : Math.round(timeSec * 1000);
      return { ok: true, latencyMs };
    }

    return {
      ok: false,
      latencyMs: null,
      error: httpCode === "000" ? "connection failed" : `unexpected HTTP ${httpCode}`,
    };
  } catch (err) {
    return { ok: false, latencyMs: null, error: (err as Error).message };
  } finally {
    await rm(tmpFile, { force: true });
  }
}

export async function pingAllIcmp(
  servers: { name: string; template: string }[],
  timeoutMs = 5000,
): Promise<ServerIcmpResult[]> {
  return Promise.all(
    servers.map(async ({ name, template }) => {
      const params = parseVlessParams(template);
      const host = params?.host ?? "";
      const port = params?.port ?? 0;
      const icmp = host ? await pingIcmp(host, timeoutMs) : { ok: false, latencyMs: null, error: "invalid template" };
      return { serverName: name, host, port, icmp };
    }),
  );
}

export async function pingAllHttp(
  servers: { name: string; template: string }[],
  users: { clientName: string; userUuid: string }[],
  timeoutMs = 10000,
): Promise<ClientHttpPingResult[]> {
  // N×M: all client×server combos in parallel
  const pairs: { clientIdx: number; serverIdx: number }[] = [];
  for (let ci = 0; ci < users.length; ci++) {
    for (let si = 0; si < servers.length; si++) {
      pairs.push({ clientIdx: ci, serverIdx: si });
    }
  }

  const results = await Promise.all(
    pairs.map(({ clientIdx, serverIdx }) =>
      pingHttp(servers[serverIdx]!.template, users[clientIdx]!.userUuid, timeoutMs),
    ),
  );

  return users.map((user, ci) => ({
    clientName: user.clientName,
    userUuid: user.userUuid,
    servers: servers.map((server, si) => ({
      serverName: server.name,
      result: results[ci * servers.length + si]!,
    })),
  }));
}
