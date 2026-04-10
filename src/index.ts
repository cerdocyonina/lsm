import dotenv from "dotenv";
import { Buffer } from "node:buffer";
import { config, validateEnvOrThrow } from "./env-validation";
import { logError, logger } from "./logger";
import { SqliteStorage } from "./storage";
import { FAKE_NGINX_404 } from "./utils";

dotenv.config({
  path: process.env.ENV_PATH || ".env",
  quiet: process.env.NODE_ENV === "production",
});

let storage: SqliteStorage | null = null;
let server: Bun.Server<unknown> | null = null;
let isShuttingDown = false;

function redactRequestPath(pathname: string): string {
  const pathParts = pathname.split("/").filter(Boolean);
  if (pathParts.length === 0) {
    return pathname;
  }

  return `/${["[token]", ...pathParts.slice(1)].join("/")}`;
}

function encodeBase64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function isAdminProbe(pathname: string, adminBasePath: string): boolean {
  return (
    pathname === adminBasePath ||
    pathname === `${adminBasePath}/` ||
    pathname.startsWith(`${adminBasePath}/`) ||
    pathname === "/admin" ||
    pathname === "/admin/" ||
    pathname.startsWith("/admin/") ||
    pathname === "/api/admin" ||
    pathname === "/api/admin/" ||
    pathname.startsWith("/api/admin/")
  );
}

function emptyNotFound(): Response {
  return new Response(null, { status: 404 });
}

async function handleRequest(req: Request): Promise<Response> {
  if (isShuttingDown) {
    return new Response("Service unavailable", { status: 503 });
  }

  const url = new URL(req.url);
  const pathname = url.pathname;
  const redactedPath = redactRequestPath(pathname);
  const adminBasePath = config.get("ADMIN_PATH");

  if (!storage) {
    logger.error("storage is not initialized");
    return new Response("Service unavailable", { status: 503 });
  }

  if (isAdminProbe(pathname, adminBasePath)) {
    return emptyNotFound();
  }

  const pathParts = pathname.split("/").filter(Boolean);
  const [clientToken, ...extraParts] = pathParts;

  if (clientToken && extraParts.length === 0) {
    const servers = storage.listServers();
    const userRecord = storage.getUserBySubscriptionToken(clientToken);
    if (!userRecord) {
      logger.warn(`invalid token attempt: ${req.method} ${pathname}`);
      return new Response(null, {
        status: 302,
        headers: { Location: config.get("FALLBACK_URL") },
      });
    }

    const configs = servers.map((serverTemplate) =>
      serverTemplate.replace("DUMMY", userRecord.userUuid),
    );
    const subContent = encodeBase64Utf8(configs.join("\n"));

    logger.info(
      `served sub for user "${userRecord.clientName}": ${req.method} ${redactedPath}`,
    );

    return new Response(subContent, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  logger.warn(`forbidden request for ${req.method} ${redactedPath}`);
  return new Response(FAKE_NGINX_404, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      Server: "nginx",
    },
  });
}

function main(): boolean {
  logger.debug(`starting app, NODE_ENV=${process.env.NODE_ENV}...`);

  config.init(validateEnvOrThrow());

  const port = config.get("PORT");
  const databasePath = config.get("DATABASE_PATH");
  storage = new SqliteStorage(databasePath);

  if (storage.listServers().length === 0) {
    throw new Error("No server templates configured in the SQLite database");
  }

  server = Bun.serve({
    port,
    fetch: handleRequest,
  });

  logger.info(`sub server is running on http://127.0.0.1:${port}`);
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

  logger.error(`shutting down: ${reason}`);

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
    process.on("beforeExit", (code) => {
      logger.warn(`process beforeExit with code ${code}`);
    });
    process.on("SIGINT", () => {
      logger.info("received SIGINT, shutting down gracefully...");
      shutdown(0, "received SIGINT");
    });
    process.on("SIGTERM", () => {
      logger.info("received SIGTERM, shutting down gracefully...");
      shutdown(0, "received SIGTERM");
    });
    process.on("exit", (code) => {
      storage?.close();
      storage = null;
      (code ? logger.warn : logger.info)(`process exit with code ${code}`);
    });
  }
} catch (error) {
  shutdown(1, "app stopped unexpectedly", error);
}
