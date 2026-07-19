import { randomBytes } from "node:crypto";

/** 16 случайных байт в base64url дают ровно 22 символа без паддинга. */
function randomSecret(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Personal-PSK для Shadowsocks-2022 ({sskey}). Ключ обязан быть СТАНДАРТНЫМ base64
 * (Xray декодит его StdEncoding — base64url с '-'/'_' и без паддинга не пройдёт), а длина —
 * совпадать с методом: 2022-blake3-aes-128-gcm требует 16 байт → 24 символа с "==" на конце.
 */
function randomShadowsocksKey(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Значение для кредa по имени плейсхолдера.
 * "user" — это логин, его делаем читаемым (как email-клиента в 3x-ui);
 * "sskey" — ss-2022 PSK в стандартном base64;
 * всё остальное — случайный секрет в base64url.
 */
export function generateCredential(key: string, clientName: string): string {
  if (key === "user") return clientName;
  if (key === "sskey") return randomShadowsocksKey();
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
