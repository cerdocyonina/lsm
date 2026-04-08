import { createHmac } from "node:crypto";
import dotenv from "dotenv";
import { loadAppConfigOrThrow } from "./app-config";
import { config, validateEnvOrThrow } from "./env-validation";

dotenv.config({
  path: process.env.ENV_PATH || ".env",
});

config.init(validateEnvOrThrow());

const PORT = config.get("PORT");
const BASE_URL = config.get("BASE_URL");
const CONFIG_PATH = config.get("CONFIG_PATH");
const SUB_LINK_SECRET = config.get("SUB_LINK_SECRET");
const { SERVERS, USERS } = loadAppConfigOrThrow(CONFIG_PATH);

function getClientToken(clientName: string): string {
  return createHmac("sha256", SUB_LINK_SECRET)
    .update(clientName)
    .digest("base64url");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function getSubLink(clientName: string, baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/sub/${getClientToken(clientName)}`;
}

const USER_UUID_BY_TOKEN = new Map(
  Object.entries(USERS).map(([clientName, userUUID]) => [
    getClientToken(clientName),
    userUUID,
  ]),
);

const [, , command, ...args] = Bun.argv;

if (command === "--print-links") {
  const baseUrl = args[0] ?? BASE_URL ?? `http://127.0.0.1:${PORT}`;

  for (const clientName of Object.keys(USERS)) {
    console.log(`${clientName} ${getSubLink(clientName, baseUrl)}`);
  }

  process.exit(0);
}

if (command === "--print-link") {
  const [clientName, baseUrlArg] = args;
  if (!clientName) {
    throw new Error("Usage: --print-link <client_name> [base_url]");
  }

  if (!(clientName in USERS)) {
    throw new Error(`Unknown client: ${clientName}`);
  }

  const baseUrl = baseUrlArg ?? BASE_URL ?? `http://127.0.0.1:${PORT}`;
  console.log(getSubLink(clientName, baseUrl));
  process.exit(0);
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    const pathParts = url.pathname.split("/").filter(Boolean);
    const [route, clientToken] = pathParts;

    if (route === "sub" && clientToken) {
      const userUUID = USER_UUID_BY_TOKEN.get(clientToken);
      if (!userUUID) {
        return new Response("Not found", { status: 404 });
      }

      const configs = SERVERS.map((s) => s.replace("DUMMY", userUUID));
      const subContent = btoa(configs.join("\n"));

      return new Response(subContent, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Forbidden", { status: 403 });
  },
});

console.log(`Sub server is running on http://127.0.0.1:${PORT}`);
