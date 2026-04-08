import dotenv from "dotenv";
import { logError, logger } from "./logger";
import { loadAppContext } from "./sub-links";

dotenv.config({
  path: process.env.ENV_PATH || ".env",
});

function main(): void {
  logger.debug(`starting cli, NODE_ENV=${process.env.NODE_ENV}...`);

  const { port, baseUrl, users, getSubLink } = loadAppContext();
  const [, , command, ...args] = Bun.argv;

  if (command === "--print-links") {
    const resolvedBaseUrl = args[0] ?? baseUrl ?? `http://127.0.0.1:${port}`;
    logger.info(
      `printing all subscription links for ${Object.keys(users).length} users`,
    );

    for (const clientName of Object.keys(users)) {
      console.log(`${clientName} ${getSubLink(clientName, resolvedBaseUrl)}`);
    }

    return;
  }

  if (command === "--print-link") {
    const [clientName, baseUrlArg] = args;
    if (!clientName) {
      throw new Error("Usage: --print-link <client_name> [base_url]");
    }

    if (!(clientName in users)) {
      throw new Error(`Unknown client: ${clientName}`);
    }

    const resolvedBaseUrl = baseUrlArg ?? baseUrl ?? `http://127.0.0.1:${port}`;
    logger.info(`printing subscription link for ${clientName}`);
    console.log(getSubLink(clientName, resolvedBaseUrl));
    return;
  }

  throw new Error("Usage: --print-link <client_name> [base_url] | --print-links [base_url]");
}

try {
  main();
} catch (error) {
  logError(error);
  logger.error("cli command failed");
  process.exit(1);
}
