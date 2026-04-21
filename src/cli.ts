#!/usr/bin/env bun

import chalk from "chalk";
import { Command } from "commander";
import dotenv from "dotenv";
import { resolve } from "node:path";
import { table } from "table";
import { z } from "zod";
import { version as VERSION } from "../package.json";
import { XUIService } from "./3x-ui";
import type { FullDump, LegacyConfig } from "./app-config";
import { loadDumpOrThrow } from "./app-config";
import { config, validateEnvOrThrow } from "./env-validation";
import { logError, logger } from "./logger";
import { checkHttpPingRequirements, pingAllHttp, pingAllIcmp } from "./ping";
import type { ClientHttpPingResult, PingResult, ServerIcmpResult } from "./ping";
import { SqliteStorage } from "./storage";
import { createSubscriptionToken, loadAppContext } from "./sub-links";
import { buildFullDump } from "./storage";

dotenv.config({
  path: resolve(__dirname, "..", process.env.ENV_PATH || ".env"),
  quiet: true,
});

const SENSITIVE_SERVER_QUERY_FIELDS = ["pbk", "sid", "spx"] as const;

// progress bar
class ProgressBar {
  private done = 0;
  private readonly width = 24;

  constructor(
    private readonly label: string,
    private readonly total: number,
    private readonly active: boolean,
  ) {
    if (this.active) this.render();
  }

  tick(): void {
    this.done++;
    if (this.active) this.render();
  }

  private render(): void {
    const filled = this.total > 0 ? Math.round((this.done / this.total) * this.width) : 0;
    const bar = "█".repeat(filled) + "░".repeat(this.width - filled);
    const pct = this.total > 0 ? Math.round((this.done / this.total) * 100) : 0;
    process.stderr.write(`\r${this.label} [${bar}] ${this.done}/${this.total} (${pct}%)`);
  }

  clear(): void {
    if (!this.active) return;
    process.stderr.write("\r" + " ".repeat(this.label.length + this.width + 20) + "\r");
  }
}

// print utils
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

// validation and db utils
function assertUuid(val: string) {
  if (!z.uuid().safeParse(val).success) {
    throw new Error(`Invalid UUID format: ${val}`);
  }
}

function withStorage<T>(action: (storage: SqliteStorage) => T): T {
  const databasePath = config.get("DATABASE_PATH");
  const storage = new SqliteStorage(databasePath);
  try {
    return action(storage);
  } finally {
    storage.close();
  }
}

function withErrorHandling(action: (...args: any[]) => Promise<void> | void) {
  return async (...args: any[]) => {
    try {
      await action(...args);
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      } else {
        logError(error);
      }
      process.exit(1);
    }
  };
}

// cli
async function bootstrap() {
  logger.debug(`starting cli, NODE_ENV=${process.env.NODE_ENV}...`);
  config.init(validateEnvOrThrow());

  const program = new Command();

  program
    .name("lsm-cli")
    .description("LSM CLI")
    .version(VERSION)
    .option("-v, --verbose", "enable verbose (debug) logging");

  // global commands
  program
    .command("import-json <path>")
    .description("Import JSON config (plain legacy format) or full dump")
    .option("--users <names>", "only import these users (comma-separated client names)")
    .option("--users-except <names>", "import all users except these (comma-separated client names)")
    .option("--servers <names>", "only import these servers (comma-separated names; templates for legacy format)")
    .option("--servers-except <names>", "import all servers except these (comma-separated names; templates for legacy format)")
    .action(
      withErrorHandling((path, options) => {
        if (options.users && options.usersExcept) {
          throw new Error("--users and --users-except are mutually exclusive");
        }
        if (options.servers && options.serversExcept) {
          throw new Error("--servers and --servers-except are mutually exclusive");
        }

        const parseNames = (val: string): Set<string> =>
          new Set(val.split(",").map((s: string) => s.trim()).filter(Boolean));

        const usersOnly = options.users ? parseNames(options.users) : null;
        const usersExcept = options.usersExcept ? parseNames(options.usersExcept) : null;
        const serversOnly = options.servers ? parseNames(options.servers) : null;
        const serversExcept = options.serversExcept ? parseNames(options.serversExcept) : null;

        const keepUser = (name: string) =>
          usersOnly ? usersOnly.has(name) : usersExcept ? !usersExcept.has(name) : true;
        const keepServer = (identifier: string) =>
          serversOnly ? serversOnly.has(identifier) : serversExcept ? !serversExcept.has(identifier) : true;

        const databasePath = config.get("DATABASE_PATH");
        const dump = loadDumpOrThrow(path);

        let userCount: number;
        let serverCount: number;

        withStorage((storage) => {
          if (Array.isArray(dump.USERS)) {
            // Full dump format
            const filtered: FullDump = {
              USERS: (dump as FullDump).USERS.filter((u) => keepUser(u.clientName)),
              SERVERS: (dump as FullDump).SERVERS.filter((s) => keepServer(s.name)),
            };
            storage.mergeFromFullDump(filtered);
            userCount = filtered.USERS.length;
            serverCount = filtered.SERVERS.length;
          } else {
            // Legacy plain format — servers identified by template string
            const legacy = dump as LegacyConfig;
            const filteredUsers = Object.fromEntries(
              Object.entries(legacy.USERS).filter(([name]) => keepUser(name)),
            ) as Record<string, string>;
            const filteredServers = legacy.SERVERS.filter((tpl) => keepServer(tpl));
            const filteredLegacy: LegacyConfig = { USERS: filteredUsers, SERVERS: filteredServers };
            const subLinkSecret = config.get("SUB_LINK_SECRET");
            storage.mergeFromLegacyConfig(filteredLegacy, subLinkSecret);
            userCount = Object.keys(filteredUsers).length;
            serverCount = filteredServers.length;
          }
        });

        logger.info(
          `imported ${userCount!} users and ${serverCount!} servers from ${path} into ${databasePath}`,
        );
      }),
    );

  program
    .command("json")
    .description("Export full database dump as JSON (round-trippable via import-json)")
    .action(
      withErrorHandling(() => {
        const dump = withStorage((storage) => buildFullDump(storage));
        console.log(JSON.stringify(dump, null, 2));
      }),
    );

  // users commands
  const usersCmd = program.command("users").description("Manage users");

  usersCmd
    .command("list [baseUrl]")
    .description("List all users and their sub links")
    .option("--json", "Output as JSON")
    .action(
      withErrorHandling((baseUrlArg, options) => {
        const { port, baseUrl, users, getSubLink } = loadAppContext();
        const resolvedBaseUrl =
          baseUrlArg ?? baseUrl ?? `http://127.0.0.1:${port}`;

        if (options.json) {
          console.log(JSON.stringify(users, null, 2));
          return;
        }

        printTable(
          ["Client", "UUID", "Subscription URL"],
          Object.entries(users).map(([clientName, userUuid]) => [
            clientName,
            userUuid,
            getSubLink(clientName, resolvedBaseUrl),
          ]),
        );
      }),
    );

  usersCmd
    .command("link <clientName> [baseUrl]")
    .description("Get subscription link for a specific user")
    .action(
      withErrorHandling((clientName, baseUrlArg) => {
        const { port, baseUrl, users, getSubLink } = loadAppContext();
        if (!(clientName in users))
          throw new Error(`Unknown client: ${clientName}`);

        const resolvedBaseUrl =
          baseUrlArg ?? baseUrl ?? `http://127.0.0.1:${port}`;
        console.log(getSubLink(clientName, resolvedBaseUrl));
      }),
    );

  usersCmd
    .command("add <clientName> [userUuid]")
    .description("Add a new user (UUID is generated if not provided)")
    .action(
      withErrorHandling((clientName, userUuid) => {
        const resolvedUuid = userUuid ?? crypto.randomUUID();
        assertUuid(resolvedUuid);
        const subLinkSecret = config.get("SUB_LINK_SECRET");

        withStorage((storage) => {
          storage.addUser(
            clientName,
            createSubscriptionToken(clientName, subLinkSecret),
            resolvedUuid,
            Date.now(),
          );
        });
        logger.info(`stored user "${clientName}" with uuid ${resolvedUuid}`);
      }),
    );

  usersCmd
    .command("set-name <oldName> <newName>")
    .description("Rename an existing user")
    .action(
      withErrorHandling((oldName, newName) => {
        const renamed = withStorage((storage) =>
          storage.renameUser(oldName, newName),
        );
        if (!renamed) throw new Error(`Unknown client: ${oldName}`);
        logger.info(`renamed user "${oldName}" to "${newName}"`);
      }),
    );

  usersCmd
    .command("set-uuid <name> <newUuid>")
    .description("Update UUID for a user")
    .action(
      withErrorHandling((name, newUuid) => {
        assertUuid(newUuid);
        const updated = withStorage((storage) =>
          storage.setUserUuid(name, newUuid),
        );
        if (!updated) throw new Error(`Unknown client: ${name}`);
        logger.info(`updated uuid for user "${name}"`);
      }),
    );

  usersCmd
    .command("remove <clientName>")
    .description("Remove a user")
    .action(
      withErrorHandling((clientName) => {
        const removed = withStorage((storage) =>
          storage.removeUser(clientName),
        );
        if (!removed) throw new Error(`Unknown client: ${clientName}`);
        logger.info(`removed user "${clientName}"`);
      }),
    );

  // servers commands
  const serversCmd = program.command("servers").description("Manage servers");

  serversCmd
    .command("list")
    .description("List all servers")
    .option("--json", "Output as JSON")
    .option("--full", "Show full unmasked templates")
    .action(
      withErrorHandling((options) => {
        const serverRecords = withStorage((storage) =>
          storage.listServerRecords(),
        );

        if (options.json) {
          console.log(
            JSON.stringify(
              serverRecords.map((r) => r.template),
              null,
              2,
            ),
          );
          return;
        }

        logger.info(`printing ${serverRecords.length} servers`);
        printTable(
          ["Name", "Order", "Template"],
          serverRecords.map(({ name, sortOrder, template }) => [
            name,
            String(sortOrder),
            options.full ? template : maskServerTemplate(template),
          ]),
        );
      }),
    );

  serversCmd
    .command("add <name> <template>")
    .description("Add a new server template")
    .action(
      withErrorHandling((name, template) => {
        withStorage((storage) => storage.addServer(name, template, Date.now()));
        logger.info(`stored server "${name}"`);
      }),
    );

  serversCmd
    .command("get-url <name>")
    .description("Get full URL/template for a server")
    .action(
      withErrorHandling((name) => {
        const template = withStorage((storage) => storage.getServerUrl(name));
        if (!template) throw new Error(`Unknown server name: ${name}`);
        console.log(template);
      }),
    );

  serversCmd
    .command("set-name <oldName> <newName>")
    .description("Rename a server")
    .action(
      withErrorHandling((oldName, newName) => {
        const renamed = withStorage((storage) =>
          storage.renameServer(oldName, newName),
        );
        if (!renamed) throw new Error(`Unknown server name: ${oldName}`);
        logger.info(`renamed server "${oldName}" to "${newName}"`);
      }),
    );

  serversCmd
    .command("set-url <name> <newUrl>")
    .description("Update URL/template for a server")
    .action(
      withErrorHandling((name, newUrl) => {
        const updated = withStorage((storage) =>
          storage.setServerUrl(name, newUrl),
        );
        if (!updated) throw new Error(`Unknown server name: ${name}`);
        logger.info(`updated url for server "${name}"`);
      }),
    );

  serversCmd
    .command("remove <name>")
    .description("Remove a server")
    .action(
      withErrorHandling((name) => {
        const removed = withStorage((storage) => storage.removeServer(name));
        if (!removed) throw new Error(`Unknown server name: ${name}`);
        logger.info(`removed server "${name}"`);
      }),
    );

  serversCmd
    .command("ping [name]")
    .description("Ping servers (ICMP + HTTP via VLESS proxy)")
    .option("--strategy <strategy>", "icmp | http | all", "all")
    .option("--timeout <ms>", "Timeout in milliseconds", "10000")
    .option("--json", "Output as JSON")
    .option("--no-progress", "Suppress progress bar")
    .option("--servers <names>", "only ping these servers (comma-separated names)")
    .option("--servers-except <names>", "ping all servers except these (comma-separated names)")
    .option("--users <names>", "only ping these users (comma-separated client names)")
    .option("--users-except <names>", "ping all users except these (comma-separated client names)")
    .action(
      withErrorHandling(async (nameArg, options) => {
        if (options.servers && options.serversExcept) {
          throw new Error("--servers and --servers-except are mutually exclusive");
        }
        if (options.users && options.usersExcept) {
          throw new Error("--users and --users-except are mutually exclusive");
        }
        if (nameArg && (options.servers || options.serversExcept)) {
          throw new Error("[name] cannot be combined with --servers/--servers-except");
        }

        const strategy = options.strategy as "icmp" | "http" | "all";
        if (!["icmp", "http", "all"].includes(strategy)) {
          throw new Error(`Invalid strategy: ${strategy}. Use icmp, http, or all.`);
        }

        const timeoutMs = parseInt(options.timeout, 10);
        if (isNaN(timeoutMs) || timeoutMs <= 0) {
          throw new Error("Timeout must be a positive number");
        }

        const parseNames = (val: string): Set<string> =>
          new Set(val.split(",").map((s: string) => s.trim()).filter(Boolean));

        const serversOnly = options.servers ? parseNames(options.servers) : null;
        const serversExcept = options.serversExcept ? parseNames(options.serversExcept) : null;
        const usersOnly = options.users ? parseNames(options.users) : null;
        const usersExcept = options.usersExcept ? parseNames(options.usersExcept) : null;

        const keepServer = (name: string) =>
          serversOnly ? serversOnly.has(name) : serversExcept ? !serversExcept.has(name) : true;
        const keepUser = (name: string) =>
          usersOnly ? usersOnly.has(name) : usersExcept ? !usersExcept.has(name) : true;

        const { serverRecords, users } = withStorage((storage) => {
          let records = storage.listServerRecords();
          if (nameArg) {
            records = records.filter((s) => s.name === nameArg);
            if (records.length === 0) throw new Error(`Unknown server name: ${nameArg}`);
          } else {
            records = records.filter((s) => keepServer(s.name));
          }
          const allUsers = storage.listUsers().filter((u) => keepUser(u.clientName));
          return { serverRecords: records, users: allUsers };
        });

        const servers = serverRecords.map((s) => ({ name: s.name, template: s.template }));
        const clients = users.map((u) => ({ clientName: u.clientName, userUuid: u.userUuid }));

        function fmtPing(r: PingResult): string {
          if (r.ok && r.latencyMs !== null) return chalk.green(`${r.latencyMs}ms`);
          if (!r.ok && !r.error && r.latencyMs === null) return chalk.gray("—");
          return chalk.red(`✗ ${r.error ?? "failed"}`);
        }

        function printIcmpTable(icmpResults: ServerIcmpResult[]) {
          logger.info(`=== ICMP results (${icmpResults.length} server(s)) ===`);
          printTable(
            ["Name", "Host:Port", "ICMP"],
            icmpResults.map((r) => [r.serverName, `${r.host}:${r.port}`, fmtPing(r.icmp)]),
          );
        }

        function printHttpTable(httpResults: ClientHttpPingResult[]) {
          if (httpResults.length === 0) return;
          const serverNames = httpResults[0]?.servers.map((s) => s.serverName) ?? [];
          logger.info(`=== HTTP results (${httpResults.length} client(s) × ${serverNames.length} server(s)) ===`);
          printTable(
            ["Client", "UUID", ...serverNames],
            httpResults.map((r) => [
              r.clientName,
              r.userUuid,
              ...r.servers.map((s) => fmtPing(s.result)),
            ]),
          );
        }

        // HTTP check — done once upfront before starting any pings
        if (strategy !== "icmp") {
          const httpReq = checkHttpPingRequirements();
          if (!httpReq.ok) {
            throw new Error(`HTTP ping unavailable: ${httpReq.error}`);
          }
        }

        const showProgress = options.progress !== false && process.stderr.isTTY;

        let icmpResults: ServerIcmpResult[] | null = null;

        if (strategy === "icmp" || strategy === "all") {
          const bar = new ProgressBar("ICMP", servers.length, showProgress);
          icmpResults = await pingAllIcmp(servers, timeoutMs, () => bar.tick());
          bar.clear();
          if (strategy === "icmp") {
            if (options.json) {
              console.log(JSON.stringify(icmpResults, null, 2));
            } else {
              printIcmpTable(icmpResults);
            }
            return;
          }
          // strategy === "all": print ICMP table now, HTTP table follows
          if (!options.json) printIcmpTable(icmpResults);
        }

        const httpTotal = servers.length * clients.length;
        const httpBar = new ProgressBar("HTTP", httpTotal, showProgress);
        const httpResults = await pingAllHttp(servers, clients, timeoutMs, () => httpBar.tick());
        httpBar.clear();

        if (options.json) {
          const out = strategy === "all" ? { icmp: icmpResults, http: httpResults } : httpResults;
          console.log(JSON.stringify(out, null, 2));
        } else {
          printHttpTable(httpResults);
        }
      }),
    );

  // 3x-ui commands
  const xuiCmd = program.command("3x-ui").description("Manage 3x-ui panel");

  xuiCmd
    .command("sync <inboundId>")
    .description("Sync users with 3x-ui panel")
    .option("--overwrite", "Overwrite existing users with matching emails")
    .option("--keep-both", "Add conflicting users under a suffixed name (e.g. client_1)")
    .action(
      withErrorHandling(async (inboundIdStr, options) => {
        const inboundId = Number(inboundIdStr);
        if (isNaN(inboundId)) throw new Error("Inbound ID must be a number");

        if (options.overwrite && options.keepBoth) {
          throw new Error("--overwrite and --keep-both are mutually exclusive");
        }

        const onConflict = options.keepBoth
          ? "keep-both"
          : options.overwrite
            ? "overwrite"
            : "skip";

        const host = config.get("XUI_HOST");
        const user = config.get("XUI_USER");
        const password = config.get("XUI_PASSWORD");

        if (!host || !user || !password) {
          throw new Error(
            "XUI_HOST, XUI_USER and XUI_PASSWORD environment variables must be set",
          );
        }

        const users = withStorage((storage) => storage.listUsers());
        const xuiService = new XUIService({ host, user, password });

        logger.debug("logging into 3x-ui...");
        await xuiService.login();
        logger.debug("3x-ui login ok");

        const stats = { added: 0, skipped: 0, overwritten: 0, "kept-both": 0, failed: 0 };

        try {
          for (const u of users) {
            logger.debug(
              `syncing user ${u.clientName} (uuid=${u.userUuid})...`,
            );

            const result = await xuiService.syncUser(
              inboundId,
              u.clientName,
              u.userUuid,
              onConflict,
            );

            stats[result]++;
          }

          logger.info("=== sync completed ===");
          logger.info(chalk.green(`added:       ${stats.added}`));
          logger.info(chalk.yellow(`overwritten: ${stats.overwritten}`));
          logger.info(chalk.cyan(`kept-both:   ${stats["kept-both"]}`));
          logger.info(chalk.blue(`skipped:     ${stats.skipped}`));
          logger.info(chalk.red(`failed:      ${stats.failed}`));
        } catch (e) {
          logger.error(`3x-ui sync failed: ${(e as Error).message}`);
          throw e;
        } finally {
          try {
            await xuiService.logout();
          } catch (e) {
            logger.warn(
              `Failed to log out from 3x-ui: ${(e as Error).message}`,
            );
          }
        }
      }),
    );

  await program.parseAsync(process.argv);
}

bootstrap().catch((error) => {
  logError(error);
  logger.error("CLI bootstrap failed");
  process.exit(1);
});
