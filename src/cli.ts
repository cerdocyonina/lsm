import dotenv from "dotenv";
import { z } from "zod";
import { loadLegacyAppConfigOrThrow } from "./app-config";
import { config, validateEnvOrThrow } from "./env-validation";
import { logError, logger } from "./logger";
import { loadAppContext } from "./sub-links";
import { SqliteStorage } from "./storage";

dotenv.config({
  path: process.env.ENV_PATH || ".env",
});

const addArgsSchema = z.tuple([z.string().min(1), z.uuid()]);

function printUsage(): void {
  console.log("Usage:");
  console.log("  bun run src/cli.ts list [base_url]");
  console.log("  bun run src/cli.ts link <client_name> [base_url]");
  console.log("  bun run src/cli.ts add <client_name> <user_uuid>");
  console.log("  bun run src/cli.ts remove <client_name>");
  console.log("  bun run src/cli.ts import-json [path]");
}

function main(): void {
  logger.debug(`starting cli, NODE_ENV=${process.env.NODE_ENV}...`);

  const [, , command, ...args] = Bun.argv;
  config.init(validateEnvOrThrow());

  if (!command || command === "help") {
    printUsage();
    return;
  }

  if (command === "import-json") {
    const legacyConfigPath = args[0] ?? config.get("LEGACY_CONFIG_PATH");
    const databasePath = config.get("DATABASE_PATH");
    const legacyConfig = loadLegacyAppConfigOrThrow(legacyConfigPath);
    const storage = new SqliteStorage(databasePath);

    try {
      storage.replaceFromConfig(legacyConfig);
    } finally {
      storage.close();
    }

    logger.info(
      `imported ${Object.keys(legacyConfig.USERS).length} users and ${legacyConfig.SERVERS.length} servers from ${legacyConfigPath} into ${databasePath}`,
    );
    return;
  }

  if (command === "add") {
    const [clientName, userUuid] = addArgsSchema.parse(args);
    const databasePath = config.get("DATABASE_PATH");
    const storage = new SqliteStorage(databasePath);

    try {
      storage.addUser(clientName, userUuid);
    } finally {
      storage.close();
    }

    logger.info(`stored user "${clientName}" in ${databasePath}`);
    return;
  }

  if (command === "remove") {
    const clientName = args[0];
    if (!clientName) {
      throw new Error("Usage: remove <client_name>");
    }

    const databasePath = config.get("DATABASE_PATH");
    const storage = new SqliteStorage(databasePath);
    let removed = false;

    try {
      removed = storage.removeUser(clientName);
    } finally {
      storage.close();
    }

    if (!removed) {
      throw new Error(`Unknown client: ${clientName}`);
    }

    logger.info(`removed user "${clientName}" from ${databasePath}`);
    return;
  }

  const { port, baseUrl, users, getSubLink } = loadAppContext();

  if (command === "list") {
    const resolvedBaseUrl = args[0] ?? baseUrl ?? `http://127.0.0.1:${port}`;
    logger.info(
      `printing all subscription links for ${Object.keys(users).length} users`,
    );

    for (const clientName of Object.keys(users)) {
      console.log(`${clientName} ${getSubLink(clientName, resolvedBaseUrl)}`);
    }

    return;
  }

  if (command === "link") {
    const [clientName, baseUrlArg] = args;
    if (!clientName) {
      throw new Error("Usage: link <client_name> [base_url]");
    }

    if (!(clientName in users)) {
      throw new Error(`Unknown client: ${clientName}`);
    }

    const resolvedBaseUrl = baseUrlArg ?? baseUrl ?? `http://127.0.0.1:${port}`;
    logger.info(`printing subscription link for ${clientName}`);
    console.log(getSubLink(clientName, resolvedBaseUrl));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  logError(error);
  printUsage();
  logger.error("cli command failed");
  process.exit(1);
}
