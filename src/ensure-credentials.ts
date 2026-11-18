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

  const generated: Record<string, string> = {};
  for (const key of missing) {
    generated[key] = generateCredential(key, user.clientName);
  }
  // Another process may have stored some of these meanwhile: use what is in the DB.
  return (
    storage.fillUserCredentials(user.profileName, user.clientName, generated, user.ownerId) ?? {
      ...user.credentials,
      ...generated,
    }
  );
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
