import { generateCredential, missingCredentialKeys, naiveLogin } from "./credentials";
import type { Storage, UserRecord } from "./storage";

/**
 * Гарантирует, что у юзера есть все креды под требуемые плейсхолдеры.
 * Самозаживление: недостающее генерится и сохраняется при первом же обращении,
 * поэтому добавление naive-сервера в профиль не требует backfill-миграции.
 */
export function ensureUserCredentials(
  storage: Storage,
  user: UserRecord,
  required: string[],
): Record<string, string> {
  const missing = missingCredentialKeys(required, user.credentials);
  if (missing.length === 0) return user.credentials;

  const next = { ...user.credentials };
  for (const key of missing) {
    next[key] = generateCredential(key, user.clientName);
  }
  storage.setUserCredentials(user.profileName, user.clientName, next, user.ownerId);
  return next;
}

/**
 * Карта для подстановки плейсхолдеров.
 * - uuid всегда из колонки user_uuid, мешок его не перебивает.
 * - {user} — это naive-логин, namespace-нутый профилем (<profile>.<clientName>),
 *   чтобы одна нода, шаренная между профилями, не ловила коллизии по username.
 *   Пароль ({pass}) остаётся из мешка кредов.
 */
export function resolvedIdentityFor(
  user: Pick<UserRecord, "userUuid" | "profileName" | "clientName">,
  credentials: Record<string, string>,
): Record<string, string> {
  return {
    ...credentials,
    user: naiveLogin(user.profileName, user.clientName),
    uuid: user.userUuid,
  };
}
