import { naiveLogin } from "./credentials";
import { ensureUserCredentials } from "./ensure-credentials";
import type { NodeRecord, Storage } from "./storage";

export type NaiveUser = { user: string; pass: string };

// Caddy basic_auth принимает только этот charset (зеркалит USER_RE/PASS_RE в CaddyBackend).
// pass всегда base64url и безопасен; login = <profile>.<clientName> и может содержать
// невалидный символ, если clientName кривой. Декларативный пуш всего списка означает, что
// один плохой логин иначе отверг бы синк всей ноды — поэтому пропускаем нарушителя и репортим.
const NAIVE_CRED_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Полный декларативный список юзеров для ноды — ОБЪЕДИНЕНИЕ юзеров ВСЕХ профилей, чей сервер
 * привязан к этой ноде. Синк декларативный (нода заменяет весь конфиг целиком), поэтому список
 * одного профиля затёр бы остальные — надо слать всех, кто попадает на ноду через любой профиль.
 * Логин (метка) namespace-нут профилем (<profile>.<clientName>), так что одинаковый clientName
 * в разных профилях (это разные люди) не конфликтует.
 *
 * Секрет берётся из мешка кредов под ключом credKey ("pass" для naive, "sskey" для ss-2022) —
 * ровно тот же, что отдаст рендер подписки (источник истины один — БД).
 *
 * validSecret решает, годится ли секрет для целевого конфига: у Caddy basic_auth строгий
 * charset, у ss-2022 PSK — стандартный base64 (валиден по построению), поэтому проверка
 * разная. Метку валидируем всегда (её видит и Caddyfile, и email в Xray).
 */
function buildDeclarativeUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
  credKey: string,
  validSecret: (secret: string) => boolean,
): { users: NaiveUser[]; skipped: string[] } {
  const valid: NaiveUser[] = [];
  const skipped: string[] = [];
  for (const profile of storage.listProfiles(ownerId)) {
    const usesNode = storage
      .listServerRecords(profile.name, ownerId)
      .some((server) => server.nodeId === nodeId);
    if (!usesNode) continue;

    for (const user of storage.listUsers(profile.name, ownerId)) {
      const login = naiveLogin(profile.name, user.clientName);
      const secret = ensureUserCredentials(storage, user, [credKey])[credKey]!;
      if (NAIVE_CRED_RE.test(login) && validSecret(secret)) {
        valid.push({ user: login, pass: secret });
      } else {
        skipped.push(`${profile.name}/${user.clientName}`);
      }
    }
  }
  return { users: valid, skipped };
}

/** Naive-список (login <profile>.<clientName> + base64url-пароль, всё в строгом charset). */
export function buildNaiveUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
): { users: NaiveUser[]; skipped: string[] } {
  return buildDeclarativeUsersForNode(storage, nodeId, ownerId, "pass", (s) => NAIVE_CRED_RE.test(s));
}

/** Shadowsocks-2022 список (метка-email + personal-PSK в стандартном base64). */
export function buildShadowsocksUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
): { users: NaiveUser[]; skipped: string[] } {
  // sskey генерится нами как стандартный base64 → валиден по построению; проверять не нужно.
  return buildDeclarativeUsersForNode(storage, nodeId, ownerId, "sskey", () => true);
}

/**
 * Синк naive-ноды декларативный: пушим весь целевой список, нода перерендеривает
 * конфиг. Удаление отдельного юзера — это тоже полный пуш, просто уже без него.
 */
export async function syncNaiveNode(
  node: NodeRecord,
  users: NaiveUser[],
): Promise<{ synced: number; failed: number; error?: string }> {
  try {
    const res = await fetch(`${node.url}/sync-users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${node.secret}` },
      body: JSON.stringify({ users }),
      tls: { rejectUnauthorized: false },
    } as RequestInit);

    const data = (await res.json()) as { synced?: number; error?: string };
    if (!res.ok || data.error) {
      return { synced: 0, failed: users.length, error: data.error ?? `node returned ${res.status}` };
    }
    return { synced: data.synced ?? users.length, failed: 0 };
  } catch (err) {
    return { synced: 0, failed: users.length, error: err instanceof Error ? err.message : String(err) };
  }
}
