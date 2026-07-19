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

export type NaiveUser = { user: string; pass: string };

/**
 * Общий контракт для провайдеров, которыми управляет нода.
 *
 * Методы опциональны, потому что у провайдеров разная природа:
 * 3x-ui императивен (панель принимает per-user add/delete), а Caddy и Xray-ss
 * декларативны (весь список юзеров рендерится в конфиг разом). Роутер отдаёт 400
 * на эндпоинт, которого у текущего бэкенда нет.
 */
export interface NodeBackend {
  readonly kind: "xui" | "naive" | "shadowsocks";
  health(timeoutMs?: number): Promise<HealthStatus>;

  // xui: per-user
  syncUser?(inboundId: number, email: string, uuid: string, onConflict: OnConflict): Promise<SyncResult>;
  checkConflicts?(emails: string[]): Promise<string[]>;
  deleteUser?(email: string): Promise<SyncResult>;

  // naive / shadowsocks: декларативный полный список
  syncUsers?(users: NaiveUser[]): Promise<{ synced: number; error?: string }>;
}
