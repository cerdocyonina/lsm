import { createHmac } from "node:crypto";
import { loadAppConfigOrThrow } from "./app-config";
import { config, validateEnvOrThrow } from "./env-validation";

export type AppContext = {
  port: number;
  baseUrl?: string;
  servers: string[];
  users: Record<string, string>;
  getClientToken: (clientName: string) => string;
  getSubLink: (clientName: string, url: string) => string;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadAppContext(): AppContext {
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

  function getSubLink(clientName: string, url: string): string {
    return `${normalizeBaseUrl(url)}/${getClientToken(clientName)}`;
  }

  return {
    port,
    baseUrl,
    servers: SERVERS,
    users: USERS,
    getClientToken,
    getSubLink,
  };
}
