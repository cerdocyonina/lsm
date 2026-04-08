import dotenv from "dotenv";
import { logError, logger } from "./logger";
import { loadAppContext } from "./sub-links";
import { FAKE_NGINX_404 } from "./utils";

dotenv.config({
  path: process.env.ENV_PATH || ".env",
});

function main(): boolean {
  logger.debug(`starting app, NODE_ENV=${process.env.NODE_ENV}...`);

  const { port, servers, users, getClientToken } = loadAppContext();

  if (servers.length === 0) {
    throw new Error("No server templates configured in the SQLite database");
  }

  const userUuidByToken = new Map(
    Object.entries(users).map(([clientName, userUUID]) => [
      getClientToken(clientName),
      userUUID,
    ]),
  );

  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const [clientToken, ...extraParts] = pathParts;

      if (clientToken && extraParts.length === 0) {
        const userUUID = userUuidByToken.get(clientToken);
        if (!userUUID) {
          logger.warn(`invalid token attempt: ${url.pathname}`);
          return new Response(null, {
            status: 302,
            headers: { Location: "https://en.wikipedia.org/wiki/Maned_Wolf" },
          });
        } else {
          const configs = servers.map((server) =>
            server.replace("DUMMY", userUUID),
          );
          const subContent = btoa(configs.join("\n"));

          const clientName = Object.keys(users).find(
            (name) => getClientToken(name) === clientToken,
          );
          logger.info(
            `served sub for user "${clientName}": ${req.method} ${url.pathname}`,
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
      logger.info("received SIGINT, shutting down gracefully...");
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      logger.info("received SIGTERM, shutting down gracefully...");
      process.exit(0);
    });
    process.on("exit", (code) => {
      (code ? logger.warn : logger.info)(`process exit with code ${code}`);
    });
  }
} catch (error) {
  logError(error);
  logger.error("app stopped unexpectedly");
  process.exit(1);
}
