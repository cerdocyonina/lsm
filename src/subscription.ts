import { ensureUserCredentials, resolvedIdentityFor } from "./ensure-credentials";
import { resolveTemplate, templatePlaceholders } from "./placeholders";
import type { Storage, UserRecord } from "./storage";

/**
 * Собирает ссылки подписки пользователя.
 *
 * Недостающие креды генерируются лениво (первый рендер нового плейсхолдера пишет
 * в БД) — поэтому добавление naive-сервера в профиль не требует backfill-миграции.
 */
export function renderSubscriptionLinks(storage: Storage, user: UserRecord): string[] {
  const serverRecords = storage.listServerRecords(user.profileName, user.ownerId);
  const required = [
    ...new Set(serverRecords.flatMap((server) => templatePlaceholders(server.template))),
  ];
  const credentials = ensureUserCredentials(storage, user, required);
  const identity = resolvedIdentityFor(user, credentials);
  return serverRecords.map((server) => resolveTemplate(server.template, identity));
}
