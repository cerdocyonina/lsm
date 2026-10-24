import { ensureUserCredentials, resolvedIdentityFor } from "./ensure-credentials";
import { applyServerPlaceholders, resolveTemplate, templatePlaceholders } from "./placeholders";
import { encodeShadowsocksLink } from "./ss-link";
import type { ServerRecord, Storage, UserRecord } from "./storage";

/**
 * Шаблоны серверов с подставленными серверными плейсхолдерами ({ip} из URL привязанной
 * ноды), в том же порядке. Юзерские плейсхолдеры остаются как есть. Общий шаг для рендера
 * подписки и пинга — чтобы оба видели один и тот же адрес.
 */
export function resolveServerTemplates(storage: Storage, servers: ServerRecord[], ownerId: number): string[] {
  const nodes = new Map(storage.listNodes(ownerId).map((node) => [node.id, node]));
  return servers.map((server) =>
    applyServerPlaceholders(server.template, server.nodeId === null ? null : nodes.get(server.nodeId) ?? null),
  );
}

/**
 * Собирает ссылки подписки пользователя.
 *
 * Недостающие креды генерируются лениво (первый рендер нового плейсхолдера пишет
 * в БД) — поэтому добавление naive-сервера в профиль не требует backfill-миграции.
 */
export function renderSubscriptionLinks(storage: Storage, user: UserRecord): string[] {
  const serverRecords = storage.listServerRecords(user.profileName, user.ownerId);
  const templates = resolveServerTemplates(storage, serverRecords, user.ownerId);
  const required = [...new Set(templates.flatMap((template) => templatePlaceholders(template)))];
  const credentials = ensureUserCredentials(storage, user, required);
  const identity = resolvedIdentityFor(user, credentials);
  // ss-шаблоны хранятся с плоским userinfo, чтобы подставился {sskey}; encodeShadowsocksLink
  // затем кодирует userinfo в base64url (SIP002). Для остальных схем это no-op.
  return templates.map((template) => encodeShadowsocksLink(resolveTemplate(template, identity)));
}
