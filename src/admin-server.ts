import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { handleAdminApiRequest } from "./admin-api";
import { config, validateEnvOrThrow } from "./env-validation";
import { logError, logger } from "./logger";
import { SqliteStorage } from "./storage";
import { createSubscriptionToken } from "./sub-links";

dotenv.config({
  path: process.env.ENV_PATH || ".env",
  quiet: process.env.NODE_ENV === "production",
});

const appRootDir = resolve(import.meta.dir, "..");
const adminDistDir = resolve(appRootDir, "web", "dist");

let storage: SqliteStorage | null = null;
let server: Bun.Server<unknown> | null = null;
let isShuttingDown = false;

function isAdminPathMatch(pathname: string, adminBasePath: string): boolean {
  return (
    pathname === adminBasePath ||
    pathname === `${adminBasePath}/` ||
    pathname.startsWith(`${adminBasePath}/`)
  );
}

function getAdminFilePath(pathname: string, adminBasePath: string): string {
  const trimmedPath =
    pathname === adminBasePath || pathname === `${adminBasePath}/`
      ? "index.html"
      : pathname.slice(adminBasePath.length + 1);
  const normalizedPath = trimmedPath.replace(/^\/+/, "");

  return resolve(adminDistDir, normalizedPath);
}

async function serveAdminAsset(
  pathname: string,
  adminBasePath: string,
): Promise<Response> {
  const requestedPath = getAdminFilePath(pathname, adminBasePath);
  const expectedPrefix = `${adminDistDir}/`;

  if (
    requestedPath !== adminDistDir &&
    !requestedPath.startsWith(expectedPrefix) &&
    requestedPath !== resolve(adminDistDir, "index.html")
  ) {
    return new Response(null, { status: 404 });
  }

  const hasFileExtension = /\.[a-z0-9]+$/i.test(requestedPath);
  const resolvedPath = existsSync(requestedPath)
    ? requestedPath
    : hasFileExtension
      ? null
      : resolve(adminDistDir, "index.html");

  if (!resolvedPath) {
    return new Response(null, { status: 404 });
  }

  if (!existsSync(resolvedPath)) {
    return new Response(
      'Admin frontend is not built yet. Run "bun install" and "bun run build:web".',
      { status: 503 },
    );
  }

  return new Response(Bun.file(resolvedPath));
}

async function handleRequest(req: Request): Promise<Response> {
  if (isShuttingDown) {
    return new Response("Service unavailable", { status: 503 });
  }

  const pathname = new URL(req.url).pathname;
  const adminBasePath = config.get("ADMIN_PATH");

  if (!storage) {
    logger.error("admin storage is not initialized");
    return new Response("Service unavailable", { status: 503 });
  }

  const adminApiResponse = await handleAdminApiRequest(
    req,
    pathname,
    storage,
    (name) => createSubscriptionToken(name, config.get("SUB_LINK_SECRET")),
    adminBasePath,
  );
  if (adminApiResponse) {
    logger.info(`admin request: ${req.method} [admin-api]`);
    return adminApiResponse;
  }

  if (isAdminPathMatch(pathname, adminBasePath)) {
    logger.info(`admin asset request: ${req.method} [admin-ui]`);
    return serveAdminAsset(pathname, adminBasePath);
  }

  return new Response(null, { status: 404 });
}

function main(): boolean {
  logger.debug(`starting admin server, NODE_ENV=${process.env.NODE_ENV}...`);

  config.init(validateEnvOrThrow());

  const adminPort = config.get("ADMIN_PORT");
  const databasePath = config.get("DATABASE_PATH");
  storage = new SqliteStorage(databasePath);

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: adminPort,
    fetch: handleRequest,
  });

  logger.info(
    `admin server is running on http://127.0.0.1:${adminPort}${config.get("ADMIN_PATH")}`,
  );
  return true;
}

function shutdown(code: number, reason: string, error?: unknown): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  if (error !== undefined) {
    logError(error);
  }

  logger.error(`shutting down admin server: ${reason}`);

  try {
    server?.stop(true);
  } catch (stopError) {
    logError(stopError);
  }

  try {
    storage?.close();
    storage = null;
  } catch (closeError) {
    logError(closeError);
  }

  process.exit(code);
}

try {
  const shouldRegisterProcessHandlers = main();

  if (shouldRegisterProcessHandlers) {
    process.on("uncaughtException", (error) => {
      shutdown(1, "uncaught exception", error);
    });
    process.on("unhandledRejection", (error) => {
      shutdown(1, "unhandled rejection", error);
    });
    process.on("SIGINT", () => {
      shutdown(0, "received SIGINT");
    });
    process.on("SIGTERM", () => {
      shutdown(0, "received SIGTERM");
    });
    process.on("exit", () => {
      storage?.close();
      storage = null;
    });
  }
} catch (error) {
  shutdown(1, "admin server stopped unexpectedly", error);
}
