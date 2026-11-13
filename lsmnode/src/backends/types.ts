export type SyncResult =
  | "added"
  | "skipped"
  | "overwritten"
  | "kept-both"
  | "deleted"
  | "not_found"
  | "failed";

export type OnConflict = "skip" | "overwrite" | "keep-both";

export type HealthStatus = { ok: boolean; error?: string };

export type { ClientOutcome, ClientSyncRequest } from "../../../src/3x-ui";
import type { ClientOutcome, ClientSyncRequest } from "../../../src/3x-ui";

export type NaiveUser = { user: string; pass: string };

export type BackendKind = "xui" | "naive" | "shadowsocks" | "mieru" | "xray";

/**
 * Общий контракт для провайдеров, которыми управляет нода.
 *
 * Методы опциональны, потому что у провайдеров разная природа:
 * 3x-ui императивен (панель принимает per-user add/delete), а Caddy, Xray (ss и vless) и mita
 * декларативны (весь список юзеров рендерится в конфиг разом). Роутер отдаёт 400
 * на эндпоинт, которого у текущего бэкенда нет.
 */
export interface NodeBackend {
  readonly kind: BackendKind;
  health(timeoutMs?: number): Promise<HealthStatus>;

  // xui: per-user
  syncUser?(inboundId: number, email: string, uuid: string, onConflict: OnConflict): Promise<SyncResult>;
  checkConflicts?(emails: string[]): Promise<string[]>;
  deleteUser?(email: string): Promise<SyncResult>;
  /** Batch, UUID-aware sync of one inbound (lsmnode ≥ 2.0). */
  syncClients?(req: ClientSyncRequest): Promise<{ results: ClientOutcome[] }>;

  // naive / shadowsocks / mieru / xray: декларативный полный список (у xray pass = UUID)
  syncUsers?(users: NaiveUser[]): Promise<{ synced: number; error?: string }>;
}
