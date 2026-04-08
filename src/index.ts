import dotenv from "dotenv";
import { logError, logger } from "./logger";
import { SqliteStorage } from "./storage";
import { loadAppContext } from "./sub-links";
import { FAKE_NGINX_404 } from "./utils";

dotenv.config({
  path: process.env.ENV_PATH || ".env",
  quiet: process.env.NODE_ENV === "production",
});

let storage: SqliteStorage | null = null;

function main(): boolean {
  logger.debug(`starting app, NODE_ENV=${process.env.NODE_ENV}...`);

  const { port, databasePath, servers } = loadAppContext();
  storage = new SqliteStorage(databasePath);

  if (servers.length === 0) {
    throw new Error("No server templates configured in the SQLite database");
  }

  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const [clientToken, ...extraParts] = pathParts;

      if (!storage) {
        logger.error("storage is not initialized");
      }
      if (storage && clientToken && extraParts.length === 0) {
        const servers = storage.listServers();
        const userRecord = storage.getUserBySubscriptionToken(clientToken);
        if (!userRecord) {
          logger.warn(`invalid token attempt: ${url.pathname}`);
          return new Response(null, {
            status: 302,
            headers: { Location: "https://en.wikipedia.org/wiki/Maned_Wolf" },
          });
        } else {
          const configs = servers.map((server) =>
            server.replace("DUMMY", userRecord.userUuid),
          );
          const subContent = btoa(configs.join("\n"));

          logger.info(
            `served sub for user "${userRecord.clientName}": ${req.method} ${url.pathname}`,
          );

          return new Response(subContent, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
            },
          });
        }
      }

      logger.warn(`forbidden request for ${url.pathname}`);
      return new Response(FAKE_NGINX_404, {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          Server: "nginx",
        },
      });
    },
  });

  logger.info(`sub server is running on http://127.0.0.1:${port}`);
  return true;
}

try {
  const shouldRegisterProcessHandlers = main();

  if (shouldRegisterProcessHandlers) {
    process.on("uncaughtException", (error) => logError(error));
    process.on("unhandledRejection", (error) => logError(error));
    process.on("beforeExit", (code) => {
      logger.warn(`process beforeExit with code ${code}`);
    });
    process.on("SIGINT", () => {
      storage?.close();
      logger.info("received SIGINT, shutting down gracefully...");
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      storage?.close();
      logger.info("received SIGTERM, shutting down gracefully...");
      process.exit(0);
    });
    process.on("exit", (code) => {
      storage?.close();
      (code ? logger.warn : logger.info)(`process exit with code ${code}`);
    });
  }
} catch (error) {
  logError(error);
  logger.error("app stopped unexpectedly");
  process.exit(1);
}
