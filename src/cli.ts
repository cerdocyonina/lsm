#!/usr/bin/env bun

import dotenv from "dotenv";
import { resolve } from "node:path";
import { table } from "table";
import { z } from "zod";
import { loadLegacyAppConfigOrThrow } from "./app-config";
import { config, validateEnvOrThrow } from "./env-validation";
import { logError, logger } from "./logger";
import { SqliteStorage } from "./storage";
import { createSubscriptionToken, loadAppContext } from "./sub-links";

dotenv.config({
  path: resolve(__dirname, "..", process.env.ENV_PATH || ".env"),
  quiet: true,
});

const addArgsSchema = z.tuple([z.string().min(1), z.uuid()]);
const renameUserArgsSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const setUserUuidArgsSchema = z.tuple([z.string().min(1), z.uuid()]);
const addServerArgsSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const renameServerArgsSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const setServerUrlArgsSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const removeServerArgsSchema = z.tuple([z.string().min(1)]);
const SENSITIVE_SERVER_QUERY_FIELDS = ["pbk", "sid", "spx"] as const;

function printTable(headers: string[], rows: string[][]): void {
  console.log(table([headers, ...rows]));
}

function maskServerTemplate(template: string): string {
  try {
    const url = new URL(template);
    for (const field of SENSITIVE_SERVER_QUERY_FIELDS) {
      if (url.searchParams.has(field)) {
        url.searchParams.set(field, "...");
      }
    }

    return url.toString();
  } catch {
    return template;
  }
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  bun run src/cli.ts users [list] [base_url] [--json]");
  console.log("  bun run src/cli.ts users link <client_name> [base_url]");
  console.log("  bun run src/cli.ts users add <client_name> <user_uuid>");
  console.log("  bun run src/cli.ts users set-name <old_name> <new_name>");
  console.log("  bun run src/cli.ts users set-uuid <name> <new_uuid>");
  console.log("  bun run src/cli.ts users remove <client_name>");
  console.log("  bun run src/cli.ts servers [list] [--json] [--full]");
  console.log("  bun run src/cli.ts servers add <name> <template>");
  console.log("  bun run src/cli.ts servers get-url <name>");
  console.log("  bun run src/cli.ts servers set-name <old_name> <new_name>");
  console.log("  bun run src/cli.ts servers set-url <name> <new_url>");
  console.log("  bun run src/cli.ts servers remove <name>");
  console.log("  bun run src/cli.ts json");
  console.log("  bun run src/cli.ts import-json <path>");
}

function main(): void {
  logger.debug(`starting cli, NODE_ENV=${process.env.NODE_ENV}...`);

  const [, , command, ...restArgs] = Bun.argv;
  config.init(validateEnvOrThrow());

  if (!command || command === "help") {
    printUsage();
    return;
  }

  if (command === "import-json") {
    const legacyConfigPath = restArgs[0];
    if (!legacyConfigPath) {
      throw new Error("Usage: import-json <path>");
    }

    const databasePath = config.get("DATABASE_PATH");
    const subLinkSecret = config.get("SUB_LINK_SECRET");
    const legacyConfig = loadLegacyAppConfigOrThrow(legacyConfigPath);
    const storage = new SqliteStorage(databasePath);

    try {
      storage.replaceFromConfig(legacyConfig, subLinkSecret);
    } finally {
      storage.close();
    }

    logger.info(
      `imported ${Object.keys(legacyConfig.USERS).length} users and ${legacyConfig.SERVERS.length} servers from ${legacyConfigPath} into ${databasePath}`,
    );
    return;
  }

  if (command === "json") {
    const { servers, users } = loadAppContext();
    console.log(
      JSON.stringify(
        {
          USERS: users,
          SERVERS: servers,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "users") {
    const knownUserActions = new Set([
      "list",
      "link",
      "add",
      "set-name",
      "set-uuid",
      "remove",
    ]);
    const userSubcommand =
      restArgs[0] && knownUserActions.has(restArgs[0]) ? restArgs[0] : "list";
    const args =
      userSubcommand === "list"
        ? restArgs.filter(
            (_, i) => i !== 0 || !knownUserActions.has(restArgs[0] ?? ""),
          )
        : restArgs.slice(1);

    if (userSubcommand === "add") {
      const [clientName, userUuid] = addArgsSchema.parse(args);
      const databasePath = config.get("DATABASE_PATH");
      const subLinkSecret = config.get("SUB_LINK_SECRET");
      const storage = new SqliteStorage(databasePath);

      try {
        storage.addUser(
          clientName,
          createSubscriptionToken(clientName, subLinkSecret),
          userUuid,
        );
      } finally {
        storage.close();
      }

      logger.info(`stored user "${clientName}" in ${databasePath}`);
      return;
    }

    if (userSubcommand === "set-name") {
      const [oldName, newName] = renameUserArgsSchema.parse(args);
      const databasePath = config.get("DATABASE_PATH");
      const storage = new SqliteStorage(databasePath);
      let renamed = false;

      try {
        renamed = storage.renameUser(oldName, newName);
      } finally {
        storage.close();
      }

      if (!renamed) {
        throw new Error(`Unknown client: ${oldName}`);
      }

      logger.info(
        `renamed user "${oldName}" to "${newName}" in ${databasePath}`,
      );
      return;
    }

    if (userSubcommand === "set-uuid") {
      const [name, userUuid] = setUserUuidArgsSchema.parse(args);
      const databasePath = config.get("DATABASE_PATH");
      const storage = new SqliteStorage(databasePath);
      let updated = false;

      try {
        updated = storage.setUserUuid(name, userUuid);
      } finally {
        storage.close();
      }

      if (!updated) {
        throw new Error(`Unknown client: ${name}`);
      }

      logger.info(`updated uuid for user "${name}" in ${databasePath}`);
      return;
    }

    if (userSubcommand === "remove") {
      const clientName = args[0];
      if (!clientName) {
        throw new Error("Usage: users remove <client_name>");
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

    const { port, baseUrl, servers, users, getSubLink } = loadAppContext();

    if (userSubcommand === "list") {
      const jsonOutput = args.includes("--json");
      const positionalArgs = args.filter((arg) => arg !== "--json");
      const resolvedBaseUrl =
        positionalArgs[0] ?? baseUrl ?? `http://127.0.0.1:${port}`;

      if (jsonOutput) {
        console.log(JSON.stringify(users, null, 2));
        return;
      }

      logger.info(
        `printing all subscription links for ${Object.keys(users).length} users`,
      );
      printTable(
        ["Client", "UUID", "Subscription URL"],
        Object.entries(users).map(([clientName, userUuid]) => [
          clientName,
          userUuid,
          getSubLink(clientName, resolvedBaseUrl),
        ]),
      );
      return;
    }

    if (userSubcommand === "link") {
      const [clientName, baseUrlArg] = args;
      if (!clientName) {
        throw new Error("Usage: users link <client_name> [base_url]");
      }

      if (!(clientName in users)) {
        throw new Error(`Unknown client: ${clientName}`);
      }

      const resolvedBaseUrl =
        baseUrlArg ?? baseUrl ?? `http://127.0.0.1:${port}`;
      logger.info(`printing subscription link for ${clientName}`);
      console.log(getSubLink(clientName, resolvedBaseUrl));
      return;
    }

    throw new Error(`Unknown command: users ${userSubcommand}`);
  }

  if (command === "servers") {
    const knownServerActions = new Set([
      "list",
      "add",
      "get-url",
      "set-name",
      "set-url",
      "remove",
    ]);
    const serverSubcommand =
      restArgs[0] && knownServerActions.has(restArgs[0]) ? restArgs[0] : "list";
    const args =
      serverSubcommand === "list"
        ? restArgs.filter(
            (_, i) => i !== 0 || !knownServerActions.has(restArgs[0] ?? ""),
          )
        : restArgs.slice(1);
    const databasePath = config.get("DATABASE_PATH");

    if (serverSubcommand === "list") {
      const jsonOutput = args.includes("--json");
      const fullOutput = args.includes("--full");
      const storage = new SqliteStorage(databasePath);

      try {
        const serverRecords = storage.listServerRecords();
        if (jsonOutput) {
          console.log(
            JSON.stringify(
              serverRecords.map(({ template }) => template),
              null,
              2,
            ),
          );
          return;
        }

        logger.info(
          `printing ${serverRecords.length} servers from ${databasePath}`,
        );
        printTable(
          ["Name", "Order", "Template"],
          serverRecords.map(({ name, sortOrder, template }) => [
            name,
            String(sortOrder),
            fullOutput ? template : maskServerTemplate(template),
          ]),
        );
      } finally {
        storage.close();
      }

      return;
    }

    if (serverSubcommand === "add") {
      const [name, template] = addServerArgsSchema.parse(args);
      const storage = new SqliteStorage(databasePath);

      try {
        storage.addServer(name, template);
      } finally {
        storage.close();
      }

      logger.info(`stored server "${name}" in ${databasePath}`);
      return;
    }

    if (serverSubcommand === "get-url") {
      const [name] = removeServerArgsSchema.parse(args);
      const storage = new SqliteStorage(databasePath);
      let template: string | null = null;

      try {
        template = storage.getServerUrl(name);
      } finally {
        storage.close();
      }

      if (!template) {
        throw new Error(`Unknown server name: ${name}`);
      }

      console.log(template);
      return;
    }

    if (serverSubcommand === "set-name") {
      const [oldName, newName] = renameServerArgsSchema.parse(args);
      const storage = new SqliteStorage(databasePath);
      let renamed = false;

      try {
        renamed = storage.renameServer(oldName, newName);
      } finally {
        storage.close();
      }

      if (!renamed) {
        throw new Error(`Unknown server name: ${oldName}`);
      }

      logger.info(
        `renamed server "${oldName}" to "${newName}" in ${databasePath}`,
      );
      return;
    }

    if (serverSubcommand === "set-url") {
      const [name, template] = setServerUrlArgsSchema.parse(args);
      const storage = new SqliteStorage(databasePath);
      let updated = false;

      try {
        updated = storage.setServerUrl(name, template);
      } finally {
        storage.close();
      }

      if (!updated) {
        throw new Error(`Unknown server name: ${name}`);
      }

      logger.info(`updated url for server "${name}" in ${databasePath}`);
      return;
    }

    if (serverSubcommand === "remove") {
      const [name] = removeServerArgsSchema.parse(args);
      const storage = new SqliteStorage(databasePath);
      let removed = false;

      try {
        removed = storage.removeServer(name);
      } finally {
        storage.close();
      }

      if (!removed) {
        throw new Error(`Unknown server name: ${name}`);
      }

      logger.info(`removed server "${name}" from ${databasePath}`);
      return;
    }

    throw new Error(`Unknown command: servers ${serverSubcommand}`);
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
