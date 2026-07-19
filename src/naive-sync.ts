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
 * Полный naive-список для ноды — ОБЪЕДИНЕНИЕ юзеров ВСЕХ профилей, чей сервер привязан
 * к этой ноде. Naive-синк декларативный (нода заменяет весь файл целиком), поэтому список
 * одного профиля затёр бы остальные — надо слать всех, кто попадает на ноду через любой
 * профиль. Логин namespace-нут профилем ({user} = <profile>.<clientName>), так что
 * одинаковый clientName в разных профилях (это разные люди) не конфликтует по username.
 *
 * Те же креды (пароль) отдаёт и рендер подписки — источник истины один (мешок в БД),
 * а логин обе стороны считают одинаково через naiveLogin().
 */
export function buildNaiveUsersForNode(
  storage: Storage,
  nodeId: number,
  ownerId: number,
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
      const pass = ensureUserCredentials(storage, user, ["pass"]).pass!;
      if (NAIVE_CRED_RE.test(login) && NAIVE_CRED_RE.test(pass)) {
        valid.push({ user: login, pass });
      } else {
        skipped.push(`${profile.name}/${user.clientName}`);
      }
    }
  }
  return { users: valid, skipped };
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
