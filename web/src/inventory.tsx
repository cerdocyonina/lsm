import { useCallback, useEffect, useState } from "react";
import { Badge } from "react-bootstrap";
import toast from "react-hot-toast";
import { api } from "./api";
import type { NodeRecord, NodeType, ProfileRecord } from "./types";

export type Host = { id: number; name: string; url: string; createdAt: number };
/** A server: one link template, optionally synced through a host's agent (nodeId → service). */
export type Connection = {
  id: number;
  name: string;
  template: string;
  nodeId: number | null;
  createdAt: number;
};
export type Membership = {
  profile: string;
  connectionId: number;
  /** Internal per-profile key (ping results, /profiles/:p/servers/:name). */
  name: string;
  displayName: string | null;
  sortOrder: number;
};
/** One 3x-ui client decision from the agent (see planClientSync in src/3x-ui.ts). */
export type SyncStep = {
  kind:
    | "add"
    | "rename"
    | "attach"
    | "overwrite"
    | "keep-both"
    | "conflict"
    | "unchanged"
    | "delete"
    | "detach"
    | "not-found";
  email: string;
  uuid: string;
  from?: string;
  as?: string;
  reason?: "revoked" | "duplicate";
  detail?: string;
  ok: boolean;
  error?: string;
};
export type SyncOutcome = {
  nodeId: number;
  name: string;
  ok: boolean;
  error?: string;
  synced?: number;
  steps?: SyncStep[];
  dryRun?: boolean;
};
export type ConflictStrategy = "skip" | "overwrite" | "keep-both";
export type PushOptions = { onConflict?: ConflictStrategy; dryRun?: boolean };
export type SyncReport = { results: SyncOutcome[]; options: PushOptions };

const STEP_WORDS: Partial<Record<SyncStep["kind"], string>> = {
  add: "added",
  rename: "renamed",
  attach: "attached",
  overwrite: "overwritten",
  "keep-both": "kept both",
  conflict: "conflicts",
  delete: "removed",
  detach: "detached",
};
/** "121 users: 112 renamed, 9 added" for 3x-ui; the plain count for the others. */
export function summarize(r: SyncOutcome): string {
  if (!r.steps) return r.synced === undefined ? "" : `${r.synced} users`;
  const counts = new Map<string, number>();
  for (const s of r.steps) {
    const word = STEP_WORDS[s.kind];
    if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const changes = [...counts].map(([w, n]) => `${n} ${w}`).join(", ");
  return `${r.synced ?? 0} users${changes ? `: ${changes}` : ", no changes"}`;
}
const conflictsOf = (r: SyncOutcome) => r.steps?.filter((s) => s.kind === "conflict").length ?? 0;
export type Inventory = {
  hosts: Host[];
  services: NodeRecord[];
  connections: Connection[];
  profiles: ProfileRecord[];
  memberships: Membership[];
};
type InventoryResponse = Inventory & {
  id?: number;
  syncResults?: SyncOutcome[];
  /** Services the save changed access on; pushed right after, in the background. */
  pendingSync?: number[];
};

/** Services are hidden in the UI, so results are named after the servers using them. */
function serverName(nodeId: number, inv: Inventory, fallback = String(nodeId)): string {
  const servers = inv.connections.filter((c) => c.nodeId === nodeId).map((c) => c.name);
  return servers.length ? servers.join(" + ") : (inv.services.find((s) => s.id === nodeId)?.name ?? fallback);
}

export type ServerTarget = {
  hostId: number;
  type: NodeType;
  path: string;
  inboundId: number;
};
export type ServerDraft = {
  id: number | null;
  name: string;
  template: string;
  target: ServerTarget | null;
  profiles: string[];
};

export const KINDS: Record<NodeType, { label: string; path: string }> = {
  xui: { label: "VLESS · 3x-ui", path: "" },
  naive: { label: "NaïveProxy", path: "/naive" },
  shadowsocks: { label: "SS2022", path: "/ss2022" },
  mieru: { label: "mieru", path: "/mieru" },
};

export function KindBadge({ type }: { type: NodeType }) {
  return (
    <Badge bg="secondary-subtle" text="secondary-emphasis" className="border border-secondary-subtle fw-normal">
      {KINDS[type].label}
    </Badge>
  );
}

/**
 * The name clients show unless a profile overrides it: the #fragment, or for mieru the
 * profile= value (mieru clients ignore #). Mirrors labelOf in src/link-label.ts.
 */
export function labelOf(template: string): string | null {
  const decode = (raw: string, form: boolean) => {
    const value = form ? raw.replace(/\+/g, " ") : raw;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const hash = template.indexOf("#");
  if (/^mierus?:\/\//.test(template)) {
    const q = template.indexOf("?");
    const end = hash === -1 ? template.length : hash;
    if (q !== -1 && q < end) {
      const param = template
        .slice(q + 1, end)
        .split(/&(?=[A-Za-z][\w-]*=)/)
        .find((p) => p.startsWith("profile="));
      if (param !== undefined) return decode(param.slice(8), true);
    }
  }
  return hash === -1 ? null : decode(template.slice(hash + 1), false);
}

/** Where the label lives in this template, for hints. */
export function labelSlot(template: string): string {
  return /^mierus?:\/\//.test(template) && /[?&]profile=/.test(template) ? "profile=" : "#";
}

export function describeTarget(service: NodeRecord | undefined): string {
  if (!service) return "";
  if (service.type === "xui") return `inbound ${service.inboundId}${service.backendPath ? ` · ${service.backendPath}` : ""}`;
  return service.backendPath || "default backend";
}

const empty: Inventory = { hosts: [], services: [], connections: [], profiles: [], memberships: [] };

export type InventoryApi = ReturnType<typeof useInventory>;

/**
 * Shared catalog for the Servers page and the profile page. Every mutation applies right
 * away; the server answers with the fresh inventory plus per-agent sync results, which
 * are reported as toasts (failures offer a retry).
 */
export function useInventory(enabled: boolean, onChanged: () => Promise<void>) {
  const [data, setData] = useState<Inventory>(empty);
  const [busy, setBusy] = useState<string | null>(null);
  /** Detailed per-client results shown in a dialog (dry runs, conflicts). */
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);

  const reload = useCallback(async () => {
    setData(await api<Inventory>("/inventory"));
  }, []);

  useEffect(() => {
    if (enabled) void reload().catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  }, [enabled, reload]);

  /**
   * Runs one inventory save. `key` marks what is busy (a chip, a row, a dialog) — only
   * until the DB write is done. Pushing users to agents follows in the background.
   */
  async function mutate(
    key: string,
    path: string,
    body?: unknown,
    method = "POST",
  ): Promise<InventoryResponse> {
    setBusy(key);
    let r: InventoryResponse;
    try {
      r = await api<InventoryResponse>(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      setData(r);
      await onChanged();
    } finally {
      setBusy(null);
    }
    if (r.pendingSync?.length) void push(r.pendingSync, r);
    return r;
  }

  /**
   * Pushes the current user lists to these services, reporting progress as a toast.
   * `onConflict` and `dryRun` only matter for 3x-ui (the others take the whole list).
   */
  async function push(ids: number[], known: Inventory = data, options: PushOptions = {}) {
    const names = ids.map((id) => serverName(id, known)).join(", ");
    const loading = toast.loading(options.dryRun ? `Checking ${names}…` : `Pushing users to ${names}…`);
    try {
      const r = await api<InventoryResponse>("/inventory/sync", {
        method: "POST",
        body: JSON.stringify({ ids, ...options }),
      });
      toast.dismiss(loading);
      const results = (r.syncResults ?? []).map((x) => ({ ...x, name: serverName(x.nodeId, known, x.name) }));
      if (options.dryRun) setSyncReport({ results, options });
      else report(results, known, options);
      // Re-read instead of using r: a later save may have landed while this push ran.
      await reload();
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), { id: loading });
    }
  }

  function report(results: SyncOutcome[], known: Inventory, options: PushOptions = {}) {
    if (!results.length) return;
    const failed = results.filter((r) => !r.ok);
    const conflicted = results.filter((r) => conflictsOf(r) > 0);
    if (!failed.length && !conflicted.length) {
      toast.success(`Pushed users to ${results.map((r) => `${r.name} (${summarize(r)})`).join(", ")}`);
      return;
    }
    const show = failed.length ? toast.error : toast;
    show(
      (t) => (
        <div className="small">
          <div className="fw-semibold mb-1">
            {failed.length ? "Saved, but some agents didn't take the update:" : "Pushed, with conflicts:"}
          </div>
          {failed.map((r) => (
            <div key={r.nodeId}>
              {r.name}: {r.error}
            </div>
          ))}
          {conflicted.map((r) => (
            <div key={`c${r.nodeId}`}>
              {r.name}: {conflictsOf(r)} client(s) already on the panel with another UUID, left as is
            </div>
          ))}
          <div className="d-flex gap-2 mt-2">
            {results.some((r) => r.steps) && (
              <button
                type="button"
                className="btn btn-sm btn-outline-dark"
                onClick={() => {
                  toast.dismiss(t.id);
                  setSyncReport({ results, options });
                }}
              >
                Details
              </button>
            )}
            {failed.length > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-outline-dark"
                onClick={() => {
                  toast.dismiss(t.id);
                  void push(failed.map((r) => r.nodeId), known, options);
                }}
              >
                Retry
              </button>
            )}
          </div>
        </div>
      ),
      { duration: 15000, ...(failed.length ? {} : { icon: "⚠️" }) },
    );
  }

  /** Same as mutate, but errors become a toast instead of a throw. */
  async function attempt(key: string, path: string, body?: unknown, method = "POST") {
    try {
      return await mutate(key, path, body, method);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  function saveServer(draft: ServerDraft) {
    return mutate("server-editor", "/inventory/servers", draft);
  }

  function setIncluded(connectionId: number, profile: string, included: boolean) {
    return attempt(`chip:${connectionId}:${profile}`, "/inventory/assignments", {
      assignments: [{ connectionId, profile, included }],
    });
  }

  // Lookups used everywhere.
  const service = (id: number | null) => data.services.find((s) => s.id === id);
  const hostOf = (c: Connection) => data.hosts.find((h) => h.id === service(c.nodeId)?.hostId);
  const profilesOf = (connectionId: number) =>
    data.memberships.filter((m) => m.connectionId === connectionId).map((m) => m.profile);

  function draftOf(c: Connection): ServerDraft {
    const s = service(c.nodeId);
    return {
      id: c.id,
      name: c.name,
      template: c.template,
      target: s?.hostId
        ? { hostId: s.hostId, type: s.type, path: s.backendPath ?? "", inboundId: s.inboundId }
        : null,
      profiles: profilesOf(c.id),
    };
  }

  /** After a profile-scoped call (order, labels) that doesn't return the inventory. */
  async function refresh() {
    await reload();
    await onChanged();
  }

  return {
    data,
    busy,
    reload,
    refresh,
    push,
    syncReport,
    closeSyncReport: () => setSyncReport(null),
    mutate,
    attempt,
    saveServer,
    setIncluded,
    service,
    hostOf,
    profilesOf,
    draftOf,
  };
}
