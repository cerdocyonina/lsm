import { version as PKG_VERSION } from "../../package.json";
import { buildBackends } from "./config";
import { type VersionInfo } from "./health-payload";
import { createAgentHandler } from "./server";

const REPO_DIR = new URL("../..", import.meta.url).pathname;

function getVersionInfo(): VersionInfo {
  try {
    const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: REPO_DIR,
    });
    const date = Bun.spawnSync(
      ["git", "log", "-1", "--format=%cd", "--date=short"],
      { cwd: REPO_DIR },
    );
    if (commit.exitCode !== 0 || date.exitCode !== 0)
      return { version: PKG_VERSION };
    return {
      version: PKG_VERSION,
      commit: new TextDecoder().decode(commit.stdout).trim(),
      date: new TextDecoder().decode(date.stdout).trim(),
    };
  } catch {
    return { version: PKG_VERSION };
  }
}

const version = getVersionInfo();

const PORT = parseInt(process.env.PORT ?? "9000", 10);
const SHARED_SECRET = process.env.SHARED_SECRET;

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

// Один агент — несколько бэкендов. Мастер адресует бэкенд первым сегментом пути
// (/<name>/sync-users); unprefixed-роуты идут в default (обратная совместимость с
// существующими нодами, которые ходят на голый /sync-users).
const { backends, defaultName } = buildBackends(process.env);

const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "0.0.0.0",
  fetch: createAgentHandler({ backends, defaultName }, SHARED_SECRET, version),
});

const mounted = [...backends.entries()]
  .map(([name, b]) => `${name}=${b.kind}`)
  .join(", ");
console.log(
  `lsm-node listening on ${server.hostname}:${server.port} — backends: ${mounted} (default=${defaultName})`,
);
