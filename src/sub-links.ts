import { createHmac } from "node:crypto";
import { config, validateEnvOrThrow } from "./env-validation";
import { SqliteStorage } from "./storage";

export type AppContext = {
  port: number;
  baseUrl?: string;
  databasePath: string;
  servers: string[];
  users: Record<string, string>;
  getSubscriptionToken: (name: string) => string;
  getSubLink: (name: string, url: string) => string;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createSubscriptionToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
}

export function loadAppContext(): AppContext {
  config.init(validateEnvOrThrow());

  const port = config.get("PORT");
  const baseUrl = config.get("BASE_URL");
  const databasePath = config.get("DATABASE_PATH");
  const subLinkSecret = config.get("SUB_LINK_SECRET");
  const storage = new SqliteStorage(databasePath);
  const userRecords = storage.listUsers();
  const servers = storage.listServers();
  storage.close();

  const users = Object.fromEntries(
    userRecords.map(({ clientName, userUuid }) => [clientName, userUuid]),
  );
  const subscriptionTokenByClientName = new Map(
    userRecords.map(({ clientName, subscriptionToken }) => [
      clientName,
      subscriptionToken,
    ]),
  );

  function getSubscriptionToken(name: string): string {
    const subscriptionToken = subscriptionTokenByClientName.get(name);
    if (!subscriptionToken) {
      throw new Error(`Unknown client: ${name}`);
    }

    return subscriptionToken;
  }

  function getSubLink(name: string, url: string): string {
    return `${normalizeBaseUrl(url)}/${getSubscriptionToken(name)}`;
  }

  return {
    port,
    baseUrl,
    databasePath,
    servers,
    users,
    getSubscriptionToken,
    getSubLink,
  };
}
