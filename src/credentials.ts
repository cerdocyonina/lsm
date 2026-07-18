import { randomBytes } from "node:crypto";

/** 16 случайных байт в base64url дают ровно 22 символа без паддинга. */
function randomSecret(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Значение для кредa по имени плейсхолдера.
 * "user" — это логин, его делаем читаемым (как email-клиента в 3x-ui);
 * всё остальное — случайный секрет.
 */
export function generateCredential(key: string, clientName: string): string {
  if (key === "user") return clientName;
  return randomSecret();
}

/**
 * Какие из требуемых кредов надо сгенерировать.
 * "uuid" исключается: он хранится в отдельной колонке user_uuid, а не в мешке.
 */
export function missingCredentialKeys(required: string[], have: Record<string, string>): string[] {
  return required.filter((key) => key !== "uuid" && !have[key]);
}
