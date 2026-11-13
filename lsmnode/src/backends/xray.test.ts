import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "./mieru";
import {
  XrayBackend,
  confdirFiles,
  defaultFlow,
  renderInboundFile,
  validateInbound,
  type XrayInbound,
} from "./xray";

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";

const REALITY: XrayInbound = {
  tag: "vless-reality",
  port: 443,
  protocol: "vless",
  settings: { decryption: "none" },
  streamSettings: {
    network: "tcp",
    security: "reality",
    realitySettings: { target: "127.0.0.1:8443", serverNames: ["example.com"], privateKey: "x", shortIds: [""] },
  },
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "xray-test-"));
}

describe("validateInbound", () => {
  test("accepts a VLESS inbound without clients", () => {
    expect(validateInbound(REALITY).tag).toBe("vless-reality");
  });

  test("rejects clients in settings: the agent owns them", () => {
    expect(() => validateInbound({ ...REALITY, settings: { clients: [] } })).toThrow(/clients/);
  });

  test("rejects other protocols, a missing tag, a bad port", () => {
    expect(() => validateInbound({ ...REALITY, protocol: "vmess" })).toThrow(/vless/);
    expect(() => validateInbound({ ...REALITY, tag: "" })).toThrow(/tag/);
    expect(() => validateInbound({ ...REALITY, port: 70000 })).toThrow(/port/);
    expect(() => validateInbound("nope")).toThrow(/object/);
  });
});

describe("defaultFlow", () => {
  test("vision on TCP + REALITY/TLS, none elsewhere", () => {
    expect(defaultFlow(REALITY)).toBe("xtls-rprx-vision");
    expect(defaultFlow({ ...REALITY, streamSettings: { network: "raw", security: "tls" } })).toBe("xtls-rprx-vision");
    expect(defaultFlow({ ...REALITY, streamSettings: { network: "xhttp", security: "reality" } })).toBe("");
    expect(defaultFlow({ ...REALITY, streamSettings: { network: "tcp", security: "none" } })).toBe("");
  });
});

describe("renderInboundFile", () => {
  test("renders the inbound with every user as a client (email = label, id = UUID)", () => {
    const json = JSON.parse(
      renderInboundFile(REALITY, [
        { user: "main.alice", pass: UUID_A },
        { user: "par.bob", pass: UUID_B },
      ], "xtls-rprx-vision"),
    );
    expect(json.inbounds).toHaveLength(1);
    const inbound = json.inbounds[0];
    expect(inbound.tag).toBe("vless-reality");
    expect(inbound.streamSettings.realitySettings.target).toBe("127.0.0.1:8443");
    expect(inbound.settings).toEqual({
      decryption: "none",
      clients: [
        { id: UUID_A, email: "main.alice", flow: "xtls-rprx-vision" },
        { id: UUID_B, email: "par.bob", flow: "xtls-rprx-vision" },
      ],
    });
  });

  test("no flow when it is empty", () => {
    const json = JSON.parse(renderInboundFile(REALITY, [{ user: "main.alice", pass: UUID_A }], ""));
    expect(json.inbounds[0].settings.clients).toEqual([{ id: UUID_A, email: "main.alice" }]);
  });

  test("an empty list closes the inbound (clients: [])", () => {
    const json = JSON.parse(renderInboundFile(REALITY, [], "xtls-rprx-vision"));
    expect(json.inbounds[0].settings.clients).toEqual([]);
  });

  test("rejects bad labels, non-UUID ids, duplicate emails", () => {
    expect(() => renderInboundFile(REALITY, [{ user: "has space", pass: UUID_A }], "")).toThrow(/email/);
    expect(() => renderInboundFile(REALITY, [{ user: "main.alice", pass: "not-a-uuid" }], "")).toThrow(/UUID/);
    expect(() =>
      renderInboundFile(REALITY, [
        { user: "main.alice", pass: UUID_A },
        { user: "main.alice", pass: UUID_B },
      ], ""),
    ).toThrow(/duplicate/);
  });
});

describe("confdirFiles", () => {
  test("lists config files in Xray's order with ours swapped for the candidate", async () => {
    const dir = tempDir();
    try {
      for (const name of ["00-base.json", "20-other.yaml", "notes.txt", ".10-vless.json.tmp"])
        writeFileSync(join(dir, name), "{}");
      const own = join(dir, "10-vless.json");
      // Our file doesn't exist yet (first sync): it still goes in its sorted place.
      expect(await confdirFiles(own, "/tmp/cand/10-vless.json")).toEqual([
        join(dir, "00-base.json"),
        "/tmp/cand/10-vless.json",
        join(dir, "20-other.yaml"),
      ]);
      writeFileSync(own, "{}");
      expect(await confdirFiles(own, "/c/10-vless.json")).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeRunner(results: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const tested: string[] = [];
  const run = async (argv: string[]): Promise<CommandResult> => {
    calls.push(argv);
    if (argv.includes("-test")) {
      // The candidate is deleted after the test, so read it while it exists.
      const candidate = argv[argv.length - 1]!;
      tested.push(readFileSync(candidate, "utf8"));
    }
    const key = argv.includes("-test") ? "test" : "restart";
    return results[key] ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, calls, tested };
}

describe("XrayBackend.syncUsers", () => {
  test("tests the whole confdir, writes the file 0640, restarts, waits for the listener", async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "00-base.json"), "{}");
      const inboundFile = join(dir, "10-vless.json");
      const { run, calls, tested } = fakeRunner();
      let probes = 0;
      const backend = new XrayBackend({
        inboundFile,
        inbound: REALITY,
        xrayBin: "/usr/local/bin/xray",
        run,
        probe: async () => ++probes >= 2, // down right after the restart, then up
      });
      expect(await backend.syncUsers([{ user: "main.alice", pass: UUID_A }])).toEqual({ synced: 1 });

      expect(calls).toHaveLength(2);
      const [test, restart] = calls;
      expect(test!.slice(0, 5)).toEqual(["/usr/local/bin/xray", "run", "-test", "-c", join(dir, "00-base.json")]);
      expect(test![5]).toBe("-c");
      expect(test![6]!.endsWith("/10-vless.json")).toBe(true);
      expect(test![6]).not.toBe(inboundFile); // the candidate, not the live file
      expect(restart).toEqual(["sudo", "-n", "systemctl", "restart", "xray"]);

      const written = readFileSync(inboundFile, "utf8");
      expect(tested).toEqual([written]);
      expect(JSON.parse(written).inbounds[0].settings.clients[0]).toEqual({
        id: UUID_A,
        email: "main.alice",
        flow: "xtls-rprx-vision",
      });
      expect(statSync(inboundFile).mode & 0o777).toBe(0o640);
      expect(probes).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed test leaves the live file alone and fails the request", async () => {
    const dir = tempDir();
    try {
      const inboundFile = join(dir, "10-vless.json");
      writeFileSync(inboundFile, "old");
      const { run, calls } = fakeRunner({
        test: { exitCode: 23, stdout: "", stderr: "Failed to start: REALITY: empty privateKey" },
      });
      const backend = new XrayBackend({ inboundFile, inbound: REALITY, run, probe: async () => true });
      await expect(backend.syncUsers([{ user: "main.alice", pass: UUID_A }])).rejects.toThrow(/privateKey/);
      expect(readFileSync(inboundFile, "utf8")).toBe("old");
      expect(calls).toHaveLength(1); // no restart
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed restart keeps the new file and reports the error", async () => {
    const dir = tempDir();
    try {
      const inboundFile = join(dir, "10-vless.json");
      const { run } = fakeRunner({ restart: { exitCode: 1, stdout: "", stderr: "sudo: a password is required" } });
      const backend = new XrayBackend({
        inboundFile,
        inbound: REALITY,
        run,
        restartCommand: ["sudo", "-n", "systemctl", "restart", "xray"],
        probe: async () => true,
      });
      const res = await backend.syncUsers([]);
      expect(res.synced).toBe(0);
      expect(res.error).toMatch(/password is required/);
      expect(JSON.parse(readFileSync(inboundFile, "utf8")).inbounds[0].settings.clients).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports when nothing listens after the restart", async () => {
    const dir = tempDir();
    try {
      const { run } = fakeRunner();
      const backend = new XrayBackend({
        inboundFile: join(dir, "10-vless.json"),
        inbound: REALITY,
        run,
        probe: async () => false,
        restartWaitMs: 0,
      });
      expect((await backend.syncUsers([])).error).toMatch(/nothing listens on 127.0.0.1:443/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid users fail before anything runs", async () => {
    const { run, calls } = fakeRunner();
    const backend = new XrayBackend({ inboundFile: "/nonexistent/10.json", inbound: REALITY, run });
    await expect(backend.syncUsers([{ user: "main.alice", pass: "nope" }])).rejects.toThrow(/UUID/);
    expect(calls).toHaveLength(0);
  });
});

describe("XrayBackend.health", () => {
  test("probes the inbound port on localhost, or on its listen address", async () => {
    const seen: string[] = [];
    const probe = async (port: number, host: string) => {
      seen.push(`${host}:${port}`);
      return host === "127.0.0.1";
    };
    expect(await new XrayBackend({ inboundFile: "/x/10.json", inbound: REALITY, probe }).health()).toEqual({ ok: true });
    const bound = new XrayBackend({ inboundFile: "/x/10.json", inbound: { ...REALITY, listen: "10.0.0.5" }, probe });
    expect(await bound.health()).toEqual({ ok: false, error: "no listener on 10.0.0.5:443" });
    expect(seen).toEqual(["127.0.0.1:443", "10.0.0.5:443"]);
  });
});

// The real thing, when xray is installed: the rendered file must pass `xray run -test`
// merged with a typical base file.
describe.skipIf(!Bun.which("xray"))("with the real xray binary", () => {
  test("the rendered REALITY inbound passes xray run -test", async () => {
    const dir = tempDir();
    try {
      const keys = Bun.spawnSync(["xray", "x25519"]).stdout.toString();
      const privateKey = /PrivateKey:\s*(\S+)/.exec(keys)![1]!;
      writeFileSync(
        join(dir, "00-base.json"),
        JSON.stringify({ log: { loglevel: "warning" }, outbounds: [{ protocol: "freedom", tag: "direct" }] }),
      );
      const inbound = validateInbound({
        ...REALITY,
        port: 18443,
        listen: "127.0.0.1",
        streamSettings: {
          ...REALITY.streamSettings,
          realitySettings: { target: "127.0.0.1:8443", serverNames: ["example.com"], privateKey, shortIds: ["0123abcd"] },
        },
      });
      const backend = new XrayBackend({
        inboundFile: join(dir, "10-vless.json"),
        inbound,
        restartCommand: ["true"],
        probe: async () => true,
      });
      expect(await backend.syncUsers([{ user: "main.alice", pass: UUID_A }, { user: "par.bob", pass: UUID_B }])).toEqual({
        synced: 2,
      });

      // And the test really runs: a broken key is caught before the live file changes.
      const broken = new XrayBackend({
        inboundFile: join(dir, "10-vless.json"),
        inbound: { ...inbound, streamSettings: { ...inbound.streamSettings, realitySettings: { target: "127.0.0.1:8443" } } },
        restartCommand: ["true"],
        probe: async () => true,
      });
      await expect(broken.syncUsers([])).rejects.toThrow(/xray run -test failed/);
      expect(JSON.parse(readFileSync(join(dir, "10-vless.json"), "utf8")).inbounds[0].settings.clients).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
