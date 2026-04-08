import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./env-validation";

const SESSION_COOKIE_NAME = "lsm_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

type SessionPayload = {
  username: string;
  expiresAt: number;
};

type SessionCookieOptions = {
  path: string;
  secure: boolean;
};

function createSignature(username: string, expiresAt: number): string {
  return createHmac("sha256", config.get("ADMIN_SESSION_SECRET"))
    .update(`${username}:${expiresAt}`)
    .digest("base64url");
}

function serializeSession(username: string, expiresAt: number): string {
  return `${username}.${expiresAt}.${createSignature(username, expiresAt)}`;
}

function parseCookies(headerValue: string | null): Map<string, string> {
  if (!headerValue) {
    return new Map();
  }

  return new Map(
    headerValue
      .split(";")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => {
        const separatorIndex = segment.indexOf("=");
        if (separatorIndex < 0) {
          return [segment, ""];
        }

        return [
          segment.slice(0, separatorIndex),
          decodeURIComponent(segment.slice(separatorIndex + 1)),
        ];
      }),
  );
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyAdminCredentials(
  username: string,
  password: string,
): boolean {
  return (
    safeCompare(username, config.get("ADMIN_USERNAME")) &&
    safeCompare(password, config.get("ADMIN_PASSWORD"))
  );
}

function getSessionCookieOptions(): SessionCookieOptions {
  if (process.env.NODE_ENV === "development") {
    return {
      path: "/",
      secure: false,
    };
  }

  return {
    path: config.get("ADMIN_PATH"),
    secure: true,
  };
}

function serializeCookieAttributes({
  path,
  secure,
  maxAge,
}: SessionCookieOptions & { maxAge: number }): string {
  return [
    `Path=${path}`,
    secure ? "Secure" : null,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function createSessionCookie(): string {
  const username = config.get("ADMIN_USERNAME");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const token = encodeURIComponent(serializeSession(username, expiresAt));
  const cookieAttributes = serializeCookieAttributes({
    ...getSessionCookieOptions(),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  return `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes}`;
}

export function clearSessionCookie(): string {
  const cookieAttributes = serializeCookieAttributes({
    ...getSessionCookieOptions(),
    maxAge: 0,
  });

  return `${SESSION_COOKIE_NAME}=; ${cookieAttributes}`;
}

export function readSession(req: Request): SessionPayload | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const rawSession = cookies.get(SESSION_COOKIE_NAME);
  if (!rawSession) {
    return null;
  }

  const [username, expiresAtRaw, signature] = rawSession.split(".");
  if (!username || !expiresAtRaw || !signature) {
    return null;
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }

  if (!safeCompare(signature, createSignature(username, expiresAt))) {
    return null;
  }

  return { username, expiresAt };
}

export function isAdminAuthenticated(req: Request): boolean {
  return readSession(req)?.username === config.get("ADMIN_USERNAME");
}
