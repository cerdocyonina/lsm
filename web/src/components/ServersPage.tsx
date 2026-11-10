import { useState } from "react";
import { Badge, Button, Card, Dropdown, Form, ListGroup, Spinner } from "react-bootstrap";
import toast from "react-hot-toast";
import { TbCopy, TbDots, TbEdit, TbPlus, TbRefresh, TbSearch, TbTrash } from "react-icons/tb";
import { api } from "../api";
import {
  describeTarget,
  KindBadge,
  KINDS,
  type Connection,
  type Host,
  type InventoryApi,
  type ServerDraft,
} from "../inventory";
import type { NodeRecord } from "../types";
import { ActionIconButton } from "./ActionIconButton";
import { DiscoverModal, HostEditor, type HostForm } from "./HostDialogs";
import { ProfileChips } from "./ProfileChips";
import { ServerEditor } from "./ServerEditor";

type HostHealth = {
  ok: boolean;
  version?: string;
  error?: string;
  services: { nodeId: number; name: string; ok: boolean; error?: string }[];
};

function HealthBadge({ health }: { health: HostHealth | "loading" | undefined }) {
  if (!health) return null;
  if (health === "loading") return <Spinner size="sm" className="text-body-tertiary" />;
  const failing = health.services.filter((s) => !s.ok);
  if (!health.version && !health.ok)
    return (
      <Badge bg="danger-subtle" text="danger-emphasis" className="border border-danger-subtle" title={health.error}>
        unreachable
      </Badge>
    );
  return (
    <Badge
      bg={failing.length ? "warning-subtle" : "success-subtle"}
      text={failing.length ? "warning-emphasis" : "success-emphasis"}
      className={`border ${failing.length ? "border-warning-subtle" : "border-success-subtle"}`}
      title={failing.map((s) => `${s.name}: ${s.error ?? "failed"}`).join("\n") || "All backends healthy"}
    >
      lsmnode {health.version ? `v${health.version}` : "?"}
      {failing.length ? ` · ${failing.length} backend${failing.length > 1 ? "s" : ""} failing` : " · healthy"}
    </Badge>
  );
}

/**
 * Hosts (one lsmnode each) and the servers they carry. Profile chips on every server
 * apply right away and push the affected users to the agent.
 */
export function ServersPage({ inv }: { inv: InventoryApi }) {
  const { data } = inv;
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<ServerDraft | null>(null);
  const [hostForm, setHostForm] = useState<HostForm | null>(null);
  const [discover, setDiscover] = useState<Host | null>(null);
  const [health, setHealth] = useState<Record<number, HostHealth | "loading">>({});
  const profiles = data.profiles.map((p) => p.name);
  const q = search.trim().toLowerCase();
  const matches = (c: Connection, h?: Host) =>
    !q || `${c.name} ${c.template} ${h?.name ?? ""}`.toLowerCase().includes(q);

  async function testHost(h: Host) {
    setHealth((old) => ({ ...old, [h.id]: "loading" }));
    try {
      const r = await api<HostHealth>(`/inventory/hosts/${h.id}/test`, { method: "POST" });
      setHealth((old) => ({ ...old, [h.id]: r }));
    } catch (e) {
      setHealth((old) => ({
        ...old,
        [h.id]: { ok: false, error: e instanceof Error ? e.message : String(e), services: [] },
      }));
    }
  }

  async function saveHost(form: HostForm) {
    const r = await inv.mutate("host", "/inventory/hosts", form);
    if (form.id === null) {
      const created = r.hosts.find((h) => h.id === r.id);
      if (created) setDiscover(created);
    }
  }

  function toggle(c: Connection, profile: string, on: boolean) {
    if (!on && !window.confirm(`Remove ${c.name} from ${profile}? Its users lose this server and are revoked on the agent.`))
      return;
    void inv.setIncluded(c.id, profile, on);
  }

  function removeServer(c: Connection) {
    const used = inv.profilesOf(c.id);
    if (
      !window.confirm(
        `Delete ${c.name}?${used.length ? ` It's removed from ${used.join(", ")} and their users are revoked on the agent.` : ""}`,
      )
    )
      return;
    void inv.attempt(`row:${c.id}`, `/inventory/connections/${c.id}`, undefined, "DELETE");
  }

  function removeHost(h: Host, servers: Connection[]) {
    if (
      !window.confirm(
        `Delete host ${h.name}${servers.length ? ` and its ${servers.length} server${servers.length > 1 ? "s" : ""} (${servers.map((c) => c.name).join(", ")})` : ""}? They're removed from every profile. Nothing is sent to the agent.`,
      )
    )
      return;
    void inv.attempt(`host:${h.id}`, `/inventory/hosts/${h.id}`, undefined, "DELETE");
  }

  // A render function, not a component: an inline component would remount every render.
  function serverRow(c: Connection, service?: NodeRecord) {
    const used = inv.profilesOf(c.id);
    const h = service?.hostId ? health[service.hostId] : undefined;
    const backend = h && h !== "loading" ? h.services.find((s) => s.nodeId === service?.id) : undefined;
    return (
      <ListGroup.Item key={c.id} className="py-3">
        <div className="server-row">
          <div className="min-w-0">
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <span className="fw-semibold">{c.name}</span>
              {service ? (
                <>
                  <KindBadge type={service.type} />
                  <small className="text-body-secondary">{describeTarget(service)}</small>
                  {backend && !backend.ok && (
                    <small className="text-danger" title={backend.error}>
                      backend failing
                    </small>
                  )}
                </>
              ) : (
                <small className="text-body-secondary">link only</small>
              )}
            </div>
            <div className="small text-body-secondary font-monospace text-truncate" title={c.template}>
              {c.template}
            </div>
          </div>
          <ProfileChips
            label={c.name}
            profiles={profiles}
            isOn={(p) => used.includes(p)}
            isBusy={(p) => inv.busy === `chip:${c.id}:${p}`}
            disabled={inv.busy !== null}
            onToggle={(p, on) => toggle(c, p, on)}
          />
          <div className="d-flex gap-1 justify-content-end">
            {service && (
              <ActionIconButton
                variant="outline-secondary"
                label={`Push users to ${c.name}'s backend now`}
                icon={inv.busy === `sync:${service.id}` ? <Spinner size="sm" /> : <TbRefresh size={16} />}
                disabled={inv.busy !== null}
                onClick={() => void inv.attempt(`sync:${service.id}`, "/inventory/sync", { ids: [service.id] })}
              />
            )}
            <ActionIconButton
              variant="outline-secondary"
              label={`Edit ${c.name}`}
              icon={<TbEdit size={16} />}
              disabled={inv.busy !== null}
              onClick={() => setEditor(inv.draftOf(c))}
            />
            <Dropdown align="end">
              <Dropdown.Toggle
                variant="outline-secondary"
                className="admin-icon-button no-caret"
                style={{ width: 32, height: 32 }}
                aria-label={`More actions for ${c.name}`}
                disabled={inv.busy !== null}
              >
                <TbDots size={16} />
              </Dropdown.Toggle>
              <Dropdown.Menu>
                <Dropdown.Item
                  onClick={() => setEditor({ ...inv.draftOf(c), id: null, name: `${c.name} copy`, profiles: [] })}
                >
                  <TbCopy className="me-2" />
                  Duplicate
                </Dropdown.Item>
                <Dropdown.Item className="text-danger" onClick={() => removeServer(c)}>
                  <TbTrash className="me-2" />
                  Delete
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown>
          </div>
        </div>
      </ListGroup.Item>
    );
  }

  const unmanaged = data.connections.filter((c) => c.nodeId === null && matches(c));
  const empty = !data.hosts.length && !data.connections.length;

  return (
    <>
      <div className="d-flex justify-content-between align-items-start gap-3 flex-wrap mb-3">
        <div>
          <h1 className="h4 mb-1">Servers</h1>
          <p className="text-body-secondary mb-0 small" style={{ maxWidth: "46rem" }}>
            A <strong>host</strong> is a machine with lsmnode. A <strong>server</strong> is one link in the
            subscription; if it runs on a host, its users are pushed there. Use the profile chips to choose who gets
            it. Order and per-profile labels are set on each profile's page.
          </p>
        </div>
        <div className="d-flex gap-2">
          <Button variant="outline-secondary" onClick={() => setEditor(newServer(null))}>
            <TbPlus className="me-1" />
            Server
          </Button>
          <Button onClick={() => setHostForm({ id: null, name: "", url: "", secret: "" })}>
            <TbPlus className="me-1" />
            Host
          </Button>
        </div>
      </div>

      {!empty && (
        <div className="position-relative mb-3">
          <TbSearch className="position-absolute text-body-tertiary" style={{ left: 12, top: 11 }} />
          <Form.Control
            className="ps-5"
            placeholder="Filter by server, host or template…"
            aria-label="Filter servers"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {empty && (
        <Card body className="text-center py-5 text-body-secondary">
          No servers yet. Add a host running lsmnode to discover its backends, or add a plain link with{" "}
          <strong>+ Server</strong>.
        </Card>
      )}

      {data.hosts.map((h) => {
        const services = data.services.filter((s) => s.hostId === h.id);
        const all = data.connections.filter((c) => services.some((s) => s.id === c.nodeId));
        const shown = all.filter((c) => matches(c, h));
        const unused = services.filter((s) => !data.connections.some((c) => c.nodeId === s.id));
        if (q && !shown.length && !h.name.toLowerCase().includes(q)) return null;
        return (
          <Card key={h.id} className="mb-3 shadow-sm">
            <Card.Header className="bg-body d-flex justify-content-between align-items-center gap-2 flex-wrap">
              <div className="d-flex align-items-center gap-2 flex-wrap min-w-0">
                <span className="fw-semibold">{h.name}</span>
                <small className="text-body-secondary font-monospace">{h.url}</small>
                <HealthBadge health={health[h.id]} />
              </div>
              <div className="d-flex gap-1">
                <Button size="sm" variant="outline-secondary" onClick={() => void testHost(h)}>
                  Test
                </Button>
                <Button size="sm" variant="outline-secondary" onClick={() => setDiscover(h)}>
                  Discover
                </Button>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => setEditor(newServer(h.id, services[0]))}
                >
                  <TbPlus className="me-1" />
                  Server
                </Button>
                <Dropdown align="end">
                  <Dropdown.Toggle
                    size="sm"
                    variant="outline-secondary"
                    className="no-caret"
                    aria-label={`More actions for ${h.name}`}
                  >
                    <TbDots />
                  </Dropdown.Toggle>
                  <Dropdown.Menu>
                    <Dropdown.Item onClick={() => setHostForm({ ...h, secret: "" })}>
                      <TbEdit className="me-2" />
                      Edit host
                    </Dropdown.Item>
                    <Dropdown.Item className="text-danger" onClick={() => removeHost(h, all)}>
                      <TbTrash className="me-2" />
                      Delete host
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown>
              </div>
            </Card.Header>
            <ListGroup variant="flush">
              {shown.map((c) => serverRow(c, services.find((s) => s.id === c.nodeId)))}
              {!q &&
                unused.map((s) => (
                  <ListGroup.Item key={s.id} className="py-2 small text-body-secondary d-flex align-items-center gap-2">
                    <span className="flex-grow-1">
                      Backend <code>{s.backendPath || "default"}</code> ({KINDS[s.type].label}) is no longer used by any
                      server. If its last push failed, revoked users may still be on the agent.
                    </span>
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      onClick={() => void inv.attempt(`sync:${s.id}`, "/inventory/sync", { ids: [s.id] })}
                    >
                      Retry push
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={() => void inv.attempt(`svc:${s.id}`, `/inventory/services/${s.id}`, undefined, "DELETE")}
                    >
                      Forget
                    </Button>
                  </ListGroup.Item>
                ))}
              {!all.length && !unused.length && (
                <ListGroup.Item className="py-3 small text-body-secondary">
                  No servers on this host yet. <strong>Discover</strong> asks the agent which backends it runs.
                </ListGroup.Item>
              )}
            </ListGroup>
          </Card>
        );
      })}

      {unmanaged.length > 0 && (
        <Card className="mb-3 shadow-sm">
          <Card.Header className="bg-body">
            <span className="fw-semibold">Links without an agent</span>{" "}
            <small className="text-body-secondary">users aren't pushed anywhere</small>
          </Card.Header>
          <ListGroup variant="flush">
            {unmanaged.map((c) => serverRow(c))}
          </ListGroup>
        </Card>
      )}

      <ServerEditor draft={editor} data={data} onSave={inv.saveServer} onClose={() => setEditor(null)} />
      <HostEditor host={hostForm} onSave={saveHost} onClose={() => setHostForm(null)} />
      <DiscoverModal
        host={discover}
        data={data}
        onClose={() => setDiscover(null)}
        onAddManually={(h) => {
          setDiscover(null);
          setEditor(newServer(h.id));
        }}
        onCreate={async (h, rows) => {
          await inv.mutate("discover", "/inventory/setup", {
            host: { id: h.id, name: h.name, url: h.url, secret: "" },
            services: rows,
          });
          toast.success(`Added ${rows.length} server${rows.length > 1 ? "s" : ""} to ${h.name}`);
        }}
      />
    </>
  );
}

function newServer(hostId: number | null, like?: NodeRecord): ServerDraft {
  return {
    id: null,
    name: "",
    template: "",
    target:
      hostId === null
        ? null
        : like
          ? { hostId, type: like.type, path: like.backendPath ?? "", inboundId: like.inboundId }
          : { hostId, type: "xui", path: "", inboundId: 1 },
    profiles: [],
  };
}
