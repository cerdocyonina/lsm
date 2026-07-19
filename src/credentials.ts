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

/**
 * Логин для naive-подстановки ({user}). Одна naive-нода может обслуживать несколько
 * профилей, а у HTTP basic_auth на username ровно один пароль — поэтому одинаковый
 * clientName в разных профилях (это РАЗНЫЕ люди с разными кредами) обязан получить
 * РАЗНЫЕ логины. Префиксуем именем профиля.
 *
 * Склейка через "." инъективна: имя профиля ограничено [a-z0-9_-] (без точки, см.
 * createProfileSchema), поэтому пара (профиль, clientName) однозначно кодируется в
 * "<profile>.<clientName>" — разные пары не дают одинаковую строку.
 */
export function naiveLogin(profileName: string, clientName: string): string {
  return `${profileName}.${clientName}`;
}
