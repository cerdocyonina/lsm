import dotenv from "dotenv";
import { createHmac } from "node:crypto";
import { loadAppConfigOrThrow } from "./app-config";
import { config, validateEnvOrThrow } from "./env-validation";
import { logError, logger } from "./logger";
import { FAKE_NGINX_404 } from "./utils";

dotenv.config({
  path: process.env.ENV_PATH || ".env",
});

function main(): boolean {
  logger.debug(`starting app, NODE_ENV=${process.env.NODE_ENV}...`);

  config.init(validateEnvOrThrow());

  const port = config.get("PORT");
  const baseUrl = config.get("BASE_URL");
  const configPath = config.get("CONFIG_PATH");
  const subLinkSecret = config.get("SUB_LINK_SECRET");
  const { SERVERS, USERS } = loadAppConfigOrThrow(configPath);

  function getClientToken(clientName: string): string {
    return createHmac("sha256", subLinkSecret)
      .update(clientName)
      .digest("base64url");
  }

  function normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, "");
  }

  function getSubLink(clientName: string, url: string): string {
    return `${normalizeBaseUrl(url)}/${getClientToken(clientName)}`;
  }

  const userUuidByToken = new Map(
    Object.entries(USERS).map(([clientName, userUUID]) => [
      getClientToken(clientName),
      userUUID,
    ]),
  );

  const [, , command, ...args] = Bun.argv;

  if (command === "--print-links") {
    const resolvedBaseUrl = args[0] ?? baseUrl ?? `http://127.0.0.1:${port}`;
    logger.info(
      `printing all subscription links for ${Object.keys(USERS).length} users`,
    );

    for (const clientName of Object.keys(USERS)) {
      console.log(`${clientName} ${getSubLink(clientName, resolvedBaseUrl)}`);
    }

    return false;
  }

  if (command === "--print-link") {
    const [clientName, baseUrlArg] = args;
    if (!clientName) {
      throw new Error("Usage: --print-link <client_name> [base_url]");
    }

    if (!(clientName in USERS)) {
      throw new Error(`Unknown client: ${clientName}`);
    }

    const resolvedBaseUrl = baseUrlArg ?? baseUrl ?? `http://127.0.0.1:${port}`;
    logger.info(`printing subscription link for ${clientName}`);
    console.log(getSubLink(clientName, resolvedBaseUrl));
    return false;
  }

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
          const configs = SERVERS.map((server) =>
            server.replace("DUMMY", userUUID),
          );
          const subContent = btoa(configs.join("\n"));

          const clientName = Object.keys(USERS).find(
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
