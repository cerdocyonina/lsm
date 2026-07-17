import { ensureUserCredentials } from "./ensure-credentials";
import type { NodeRecord, Storage, UserRecord } from "./storage";

export type NaiveUser = { user: string; pass: string };

/**
 * Собирает полный список naive-кредов, генерируя недостающие.
 * Те же креды потом отдаст рендер подписки — источник истины один (мешок в БД).
 */
export function buildNaiveUsers(storage: Storage, users: UserRecord[]): NaiveUser[] {
  return users.map((user) => {
    const credentials = ensureUserCredentials(storage, user, ["user", "pass"]);
    return { user: credentials.user!, pass: credentials.pass! };
  });
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
