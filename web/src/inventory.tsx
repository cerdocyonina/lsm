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
export type SyncOutcome = {
  nodeId: number;
  name: string;
  ok: boolean;
  error?: string;
  synced?: number;
};
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

/** Decoded #label of a template — what clients show unless a profile overrides it. */
export function labelOf(template: string): string | null {
  const hash = template.indexOf("#");
  if (hash === -1) return null;
  const raw = template.slice(hash + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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

  /** Pushes the current user lists to these services, reporting progress as a toast. */
  async function push(ids: number[], known: Inventory = data) {
    const names = ids.map((id) => serverName(id, known)).join(", ");
    const loading = toast.loading(`Pushing users to ${names}…`);
    try {
      const r = await api<InventoryResponse>("/inventory/sync", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      toast.dismiss(loading);
      report(r.syncResults ?? [], known);
      // Re-read instead of using r: a later save may have landed while this push ran.
      await reload();
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), { id: loading });
    }
  }

  function report(raw: SyncOutcome[], known: Inventory) {
    if (!raw.length) return;
    const results = raw.map((r) => ({ ...r, name: serverName(r.nodeId, known, r.name) }));
    const failed = results.filter((r) => !r.ok);
    if (!failed.length) {
      toast.success(
        `Pushed users to ${results.map((r) => (r.synced === undefined ? r.name : `${r.name} (${r.synced})`)).join(", ")}`,
      );
      return;
    }
    toast.error(
      (t) => (
        <div className="small">
          <div className="fw-semibold mb-1">Saved, but some agents didn't take the update:</div>
          {failed.map((r) => (
            <div key={r.nodeId}>
              {r.name}: {r.error}
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm btn-outline-dark mt-2"
            onClick={() => {
              toast.dismiss(t.id);
              void push(failed.map((r) => r.nodeId), known);
            }}
          >
            Retry
          </button>
        </div>
      ),
      { duration: 15000 },
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
