import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { describeFailure, spawnCommand, type CommandRunner } from "./mieru";
import { tcpProbe } from "./shadowsocks";
import type { HealthStatus, NaiveUser, NodeBackend } from "./types";

// email = <profile>.<clientName>, the same label naive/mieru use and 3x-ui's client email.
const LABEL_RE = /^[A-Za-z0-9._-]+$/;
// Xray would also take any string as id (it hashes it into a UUIDv5), but the master always
// sends a real UUID, so anything else is a bug worth rejecting.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISION = "xtls-rprx-vision";
const DEFAULT_RESTART = ["sudo", "-n", "systemctl", "restart", "xray"];
// What `xray run -confdir` loads (format "auto" picks the decoder by extension).
const CONF_EXTENSIONS = new Set([".json", ".jsonc", ".toml", ".yaml", ".yml"]);

/** The managed inbound from backends.json: a normal Xray inbound, minus settings.clients. */
export type XrayInbound = {
  tag: string;
  port: number;
  protocol: "vless";
  listen?: string;
  settings?: Record<string, unknown>;
  streamSettings?: Record<string, unknown>;
} & Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the inbound from backends.json. Only what the agent relies on is checked here;
 * the rest (REALITY keys, sniffing, ...) is left to `xray run -test` on every sync.
 */
export function validateInbound(value: unknown): XrayInbound {
  if (!isObject(value)) throw new Error("inbound must be an object");
  const { tag, port, protocol, listen, settings, streamSettings } = value;
  if (typeof tag !== "string" || !tag) throw new Error("inbound.tag must be a non-empty string");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("inbound.port must be an integer 1-65535");
  if (protocol !== "vless") throw new Error(`inbound.protocol must be "vless", got ${JSON.stringify(protocol)}`);
  if (listen !== undefined && typeof listen !== "string") throw new Error("inbound.listen must be a string");
  if (settings !== undefined && !isObject(settings)) throw new Error("inbound.settings must be an object");
  if (settings && "clients" in settings)
    throw new Error('inbound.settings must not contain "clients": lsm-node owns the user list');
  if (streamSettings !== undefined && !isObject(streamSettings))
    throw new Error("inbound.streamSettings must be an object");
  return value as XrayInbound;
}

/** Vision only works on raw TCP under TLS or REALITY; anywhere else Xray rejects the flow. */
export function defaultFlow(inbound: XrayInbound): string {
  const network = inbound.streamSettings?.network ?? "tcp";
  const security = inbound.streamSettings?.security;
  return (network === "tcp" || network === "raw") && (security === "reality" || security === "tls")
    ? VISION
    : "";
}

/**
 * Renders the agent's file for Xray's -confdir: just the managed inbound, with every user as
 * a VLESS client (email = label, id = UUID). The rest of the config (log, api, outbounds,
 * routing) lives in the operator's own files in the same directory.
 *
 * An empty list renders clients: [] and VLESS then lets nobody in.
 */
export function renderInboundFile(inbound: XrayInbound, users: NaiveUser[], flow: string): string {
  const seen = new Set<string>();
  for (const { user, pass } of users) {
    if (!LABEL_RE.test(user)) throw new Error(`invalid client email ${JSON.stringify(user)}: expected ${LABEL_RE}`);
    if (!UUID_RE.test(pass)) throw new Error(`invalid UUID for client ${JSON.stringify(user)}`);
    // Xray refuses to start an inbound with two clients under one email.
    if (seen.has(user)) throw new Error(`duplicate client email ${JSON.stringify(user)}`);
    seen.add(user);
  }
  const clients = users.map(({ user, pass }) => ({ id: pass, email: user, ...(flow ? { flow } : {}) }));
  const settings = { decryption: "none", ...inbound.settings, clients };
  return JSON.stringify({ inbounds: [{ ...inbound, settings }] }, null, 2) + "\n";
}

/** The files `xray run -confdir <dir>` would load, in its order, with ours swapped for `candidate`. */
export async function confdirFiles(inboundFile: string, candidate: string): Promise<string[]> {
  const dir = dirname(inboundFile);
  const own = basename(inboundFile);
  const names = (await readdir(dir)).filter((n) => CONF_EXTENSIONS.has(extname(n)) && n !== own);
  return [...names, own].sort().map((n) => (n === own ? candidate : join(dir, n)));
}

export type XrayDeps = {
  /** The agent's own file inside the directory Xray runs with (`xray run -confdir <dir>`). */
  inboundFile: string;
  /** The managed VLESS inbound, everything except settings.clients. */
  inbound: XrayInbound;
  /** Client flow; default xtls-rprx-vision on TCP + REALITY/TLS, none otherwise. "" turns it off. */
  flow?: string;
  /** Path to the xray binary, used for `xray run -test` (default "xray" from PATH). */
  xrayBin?: string;
  /** Applies the new file (default: sudo -n systemctl restart xray). */
  restartCommand?: string[];
  /** Injected in tests; defaults to Bun.spawn. */
  run?: CommandRunner;
  /** Injected in tests; defaults to a TCP connect. */
  probe?: (port: number, host: string) => Promise<boolean>;
  /** How long to wait for the inbound to listen again after a restart (default 10 s). */
  restartWaitMs?: number;
};

/**
 * VLESS users of a bare Xray (no 3x-ui). Declarative, like ss-2022: the whole user list is
 * rendered into the agent's file in Xray's confdir. Every sync is checked with
 * `xray run -test` against the whole directory first, so a bad file never reaches the running
 * Xray. Then Xray is restarted, which drops open connections for a moment.
 */
export class XrayBackend implements NodeBackend {
  public readonly kind = "xray" as const;

  public constructor(private readonly deps: XrayDeps) {}

  private get probeHost(): string {
    const listen = this.deps.inbound.listen;
    return !listen || listen === "0.0.0.0" || listen === "::" ? "127.0.0.1" : listen;
  }

  private probe(): Promise<boolean> {
    const probe = this.deps.probe ?? ((port: number, host: string) => tcpProbe(port, 3000, host));
    return probe(this.deps.inbound.port, this.probeHost);
  }

  private run(argv: string[]) {
    return (this.deps.run ?? spawnCommand)(argv);
  }

  public async health(): Promise<HealthStatus> {
    try {
      return (await this.probe())
        ? { ok: true }
        : { ok: false, error: `no listener on ${this.probeHost}:${this.deps.inbound.port}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async syncUsers(users: NaiveUser[]): Promise<{ synced: number; error?: string }> {
    const { inbound, inboundFile } = this.deps;
    const content = renderInboundFile(inbound, users, this.deps.flow ?? defaultFlow(inbound));

    // Test the whole directory with the new file in place of the old one. The candidate sits
    // in a private tmp dir under the same basename, so Xray picks the decoder by extension.
    const dir = await mkdtemp(join(tmpdir(), "lsm-xray-"));
    try {
      const candidate = join(dir, basename(inboundFile));
      await writeFile(candidate, content, { encoding: "utf8", mode: 0o600 });
      const files = await confdirFiles(inboundFile, candidate);
      const argv = [this.deps.xrayBin ?? "xray", "run", "-test", ...files.flatMap((f) => ["-c", f])];
      const tested = await this.run(argv);
      // Xray keeps running on the old file: the whole request fails.
      if (tested.exitCode !== 0) throw new Error(describeFailure([argv[0]!, "run", "-test"], tested));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // Swap in atomically. The tmp name doesn't end in .json, so a restart in between can't
    // load half a file. 0640: the file holds REALITY keys; Xray reads it through the
    // directory's group (see the README).
    const tmp = join(dirname(inboundFile), `.${basename(inboundFile)}.tmp`);
    await rm(tmp, { force: true });
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o640 });
    await rename(tmp, inboundFile);

    const restart = this.deps.restartCommand ?? DEFAULT_RESTART;
    const restarted = await this.run(restart);
    if (restarted.exitCode !== 0) {
      // The file is saved but Xray still runs the old one; it applies on the next restart.
      return { synced: users.length, error: describeFailure(restart, restarted) };
    }

    // systemctl returns once the process is spawned, not once it listens.
    const deadline = Date.now() + (this.deps.restartWaitMs ?? 10_000);
    while (!(await this.probe().catch(() => false))) {
      if (Date.now() >= deadline)
        return {
          synced: users.length,
          error: `xray restarted, but nothing listens on ${this.probeHost}:${inbound.port}`,
        };
      await Bun.sleep(250);
    }
    return { synced: users.length };
  }
}
