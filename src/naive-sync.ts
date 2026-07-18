import { ensureUserCredentials } from "./ensure-credentials";
import type { NodeRecord, Storage, UserRecord } from "./storage";

export type NaiveUser = { user: string; pass: string };

// Caddy basic_auth принимает только этот charset (зеркалит USER_RE/PASS_RE в CaddyBackend).
// pass всегда base64url и безопасен; user = clientName и может им НЕ быть. Декларативный
// пуш всего списка означает, что один плохой логин иначе отверг бы синк всей ноды — поэтому
// пропускаем нарушителя (валидного naive-логина у него всё равно быть не может) и репортим.
const NAIVE_CRED_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Собирает полный список naive-кредов, генерируя недостающие.
 * Те же креды потом отдаст рендер подписки — источник истины один (мешок в БД).
 */
export function buildNaiveUsers(
  storage: Storage,
  users: UserRecord[],
): { users: NaiveUser[]; skipped: string[] } {
  const valid: NaiveUser[] = [];
  const skipped: string[] = [];
  for (const user of users) {
    const credentials = ensureUserCredentials(storage, user, ["user", "pass"]);
    const naiveUser = credentials.user!;
    const naivePass = credentials.pass!;
    if (NAIVE_CRED_RE.test(naiveUser) && NAIVE_CRED_RE.test(naivePass)) {
      valid.push({ user: naiveUser, pass: naivePass });
    } else {
      skipped.push(user.clientName);
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
