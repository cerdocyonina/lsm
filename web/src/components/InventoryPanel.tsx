import { useEffect, useId, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Form,
  Modal,
  Table,
} from "react-bootstrap";
import { api, profilePath } from "../api";
import type {
  NodeRecord,
  NodeTestResult,
  NodeType,
  ProfileRecord,
} from "../types";

type Host = { id: number; name: string; url: string };
type Connection = {
  id: number;
  name: string;
  template: string;
  nodeId: number | null;
};
type Membership = {
  displayName?: string | null;
  profile: string;
  connectionId: number;
  name: string;
  sortOrder: number;
};
type Sync = {
  nodeId: number;
  name: string;
  ok: boolean;
  error?: string;
  synced?: number;
};
type Inventory = {
  hosts: Host[];
  services: NodeRecord[];
  connections: Connection[];
  profiles: ProfileRecord[];
  memberships: Membership[];
  syncResults?: Sync[];
  id?: number;
};
const empty: Inventory = {
  hosts: [],
  services: [],
  connections: [],
  profiles: [],
  memberships: [],
};
const kinds: Record<NodeType, string> = {
  xui: "VLESS / 3x-ui",
  naive: "NaïveProxy",
  shadowsocks: "SS2022",
  mieru: "mieru",
};
type DraftService = {
  name: string;
  type: NodeType;
  path: string;
  inboundId: number;
  template: string;
  profiles: string[];
};
const newService = (): DraftService => ({
  name: "",
  type: "naive",
  path: "/naive",
  inboundId: 0,
  template: "",
  profiles: [],
});
const key = (id: number, p: string) => `${id}:${p}`;

/** Shared inventory and profile picker use the same definitions and membership controls. */
export function InventoryPanel({
  profile,
  revision,
  onChanged,
}: {
  profile?: string;
  revision?: string;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<Inventory>(empty);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Sync[]>([]);
  const [host, setHost] = useState<{
    id: number | null;
    name: string;
    url: string;
    secret: string;
  } | null>(null);
  const [drafts, setDrafts] = useState<DraftService[]>([]);
  const [connection, setConnection] = useState<
    (Connection & { profiles: string[] }) | null
  >(null);
  const [service, setService] = useState<NodeRecord | null>(null);
  const [search, setSearch] = useState("");
  const [aliases, setAliases] = useState<Record<number, string>>({});
  async function load() {
    setData(await api<Inventory>("/inventory"));
    setPending({});
    setAliases({});
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [profile, revision]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function post(action: string, body: unknown) {
    const next = await api<Inventory>(`/inventory/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (next.syncResults) setResults(next.syncResults);
    return next;
  }
  const included = (id: number, p: string) =>
    pending[key(id, p)] ??
    data.memberships.some((m) => m.connectionId === id && m.profile === p);
  function toggle(connections: Connection[], p: string, value: boolean) {
    setPending((old) => ({
      ...old,
      ...Object.fromEntries(connections.map((c) => [key(c.id, p), value])),
    }));
  }
  const profiles = profile
    ? data.profiles.filter((p) => p.name === profile)
    : data.profiles;
  async function saveMemberships() {
    await run(async () => {
      const assignments = Object.entries(pending).map(([k, included]) => {
        const i = k.indexOf(":");
        return {
          connectionId: Number(k.slice(0, i)),
          profile: k.slice(i + 1),
          included,
        };
      });
      if (assignments.length) await post("assignments", { assignments });
      if (profile)
        for (const [id, name] of Object.entries(aliases)) {
          const old = data.memberships.find(
            (m) => m.connectionId === Number(id) && m.profile === profile,
          );
          if (old && name !== (old.displayName ?? ""))
            await api(
              profilePath(profile, `/servers/${encodeURIComponent(old.name)}`),
              {
                method: "PATCH",
                body: JSON.stringify({ displayName: name.trim() || null }),
              },
            );
        }
    });
  }
  async function remove(kind: string, id: number, label: string) {
    if (
      !window.confirm(
        `Delete ${label}?${kind === "connections" ? " This removes it from every profile." : ""}`,
      )
    )
      return;
    await run(async () => {
      const r = await api<Inventory>(`/inventory/${kind}/${id}`, {
        method: "DELETE",
      });
      setResults(r.syncResults ?? []);
    });
  }
  function openHost(h?: Host, addService = false) {
    setHost(
      h ? { ...h, secret: "" } : { id: null, name: "", url: "", secret: "" },
    );
    setDrafts(addService || !h ? [newService()] : []);
  }
  function openConnection(c?: Connection) {
    setConnection(
      c
        ? {
            ...c,
            profiles: data.memberships
              .filter((m) => m.connectionId === c.id)
              .map((m) => m.profile),
          }
        : {
            id: 0,
            name: "",
            template: "",
            nodeId: null,
            profiles: profile ? [profile] : [],
          },
    );
  }
  const visible = (c: Connection) =>
    `${c.name} ${data.services.find((n) => n.id === c.nodeId)?.name ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase());
  function renderConnections(connections: Connection[]) {
    return (
      <Table responsive size="sm" className="align-middle mb-0">
        <thead>
          <tr>
            <th>Connection</th>
            {profiles.map((p) => (
              <th key={p.id} className="text-center">
                {p.name}
              </th>
            ))}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {[...connections]
            .sort((a, b) =>
              profile
                ? (data.memberships.find(
                    (m) => m.connectionId === a.id && m.profile === profile,
                  )?.sortOrder ?? Infinity) -
                  (data.memberships.find(
                    (m) => m.connectionId === b.id && m.profile === profile,
                  )?.sortOrder ?? Infinity)
                : a.id - b.id,
            )
            .map((c) => {
              const m = data.memberships.find(
                (m) => m.connectionId === c.id && m.profile === profile,
              );
              return (
                <tr key={c.id}>
                  <td>
                    <div className="fw-semibold">{c.name}</div>
                    <small className="text-body-secondary">
                      {data.services.find((n) => n.id === c.nodeId)?.name ??
                        "Unmanaged link"}
                    </small>
                    {profile && m && (
                      <Form.Control
                        size="sm"
                        className="mt-1"
                        aria-label={`Display name for ${c.name}`}
                        value={aliases[c.id] ?? m.displayName ?? ""}
                        placeholder="Default link name"
                        onChange={(e) =>
                          setAliases({ ...aliases, [c.id]: e.target.value })
                        }
                      />
                    )}
                  </td>
                  {profiles.map((p) => (
                    <td key={p.id} className="text-center">
                      <Form.Check
                        aria-label={`Include ${c.name} in ${p.name}`}
                        checked={included(c.id, p.name)}
                        disabled={busy}
                        onChange={(e) => toggle([c], p.name, e.target.checked)}
                      />
                    </td>
                  ))}
                  <td>
                    <div className="d-flex gap-1 flex-wrap">
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy}
                        onClick={() => openConnection(c)}
                      >
                        Edit shared
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy}
                        onClick={() =>
                          setConnection({
                            ...c,
                            id: 0,
                            name: `${c.name} variant`,
                            profiles: profile ? [profile] : [],
                          })
                        }
                      >
                        Create variant
                      </Button>
                      {profile && m && (
                        <>
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            aria-label={`Move ${c.name} up`}
                            disabled={busy}
                            onClick={() => void move(c.id, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            aria-label={`Move ${c.name} down`}
                            disabled={busy}
                            onClick={() => void move(c.id, 1)}
                          >
                            ↓
                          </Button>
                        </>
                      )}
                      {!profile && (
                        <Button
                          size="sm"
                          variant="outline-danger"
                          disabled={busy}
                          onClick={() =>
                            void remove("connections", c.id, c.name)
                          }
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </Table>
    );
  }
  async function move(id: number, delta: number) {
    if (!profile) return;
    await run(async () => {
      const list = data.memberships
        .filter((m) => m.profile === profile)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const i = list.findIndex((m) => m.connectionId === id),
        j = i + delta;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      await api(profilePath(profile, "/servers/order"), {
        method: "PUT",
        body: JSON.stringify({ order: list.map((m) => m.name) }),
      });
    });
  }
  return (
    <>
      <Card className="shadow-sm">
        <Card.Body>
          <div className="d-flex justify-content-between gap-2 flex-wrap mb-3">
            <div>
              <h2 className="h5">
                {profile ? "Subscription connections" : "Servers"}
              </h2>
              <p className="text-body-secondary mb-0">
                {profile
                  ? "Choose shared connections for this profile. Changes sync existing users."
                  : "Configure each host and service once, then choose which profiles use them."}
              </p>
            </div>
            <div className="d-flex gap-2 align-items-start">
              {!profile && (
                <Button onClick={() => openHost()} disabled={busy}>
                  Add host
                </Button>
              )}
              <Button
                variant="outline-secondary"
                onClick={() => openConnection()}
                disabled={busy}
              >
                Add connection
              </Button>
            </div>
          </div>
          {error && <Alert variant="danger">{error}</Alert>}
          {results.length > 0 && (
            <Alert variant={results.some((r) => !r.ok) ? "warning" : "success"}>
              <div className="fw-semibold">Saved. Service sync results:</div>
              {results.map((r) => (
                <div key={r.nodeId}>
                  {r.name}:{" "}
                  {r.ok
                    ? r.synced === undefined
                      ? "Healthy"
                      : `${r.synced} users synced`
                    : r.error}
                </div>
              ))}
              {results.some((r) => !r.ok) && (
                <Button
                  size="sm"
                  variant="outline-dark"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await post("sync", {
                        ids: results.filter((r) => !r.ok).map((r) => r.nodeId),
                      });
                    })
                  }
                >
                  Retry failed services
                </Button>
              )}
            </Alert>
          )}
          <Form.Control
            placeholder="Find a connection or service…"
            aria-label="Find a connection"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-3"
          />
          {profile && data.memberships.some((m) => m.profile === profile) && (
            <div className="mb-3">
              <h3 className="h6">Subscription order</h3>
              <ol className="list-group list-group-numbered">
                {data.memberships
                  .filter((m) => m.profile === profile)
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((m, i, list) => (
                    <li
                      key={m.connectionId}
                      className="list-group-item d-flex align-items-center gap-2"
                    >
                      <span className="flex-grow-1">
                        {m.displayName ??
                          data.connections.find((c) => c.id === m.connectionId)
                            ?.name ??
                          m.name}
                      </span>
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy || i === 0}
                        aria-label={`Move ${m.name} earlier`}
                        onClick={() => void move(m.connectionId, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy || i === list.length - 1}
                        aria-label={`Move ${m.name} later`}
                        onClick={() => void move(m.connectionId, 1)}
                      >
                        ↓
                      </Button>
                    </li>
                  ))}
              </ol>
            </div>
          )}
          {data.hosts.map((h) => {
            const services = data.services.filter((n) => n.hostId === h.id);
            const ids = new Set(services.map((n) => n.id));
            const connections = data.connections.filter(
              (c) => c.nodeId !== null && ids.has(c.nodeId) && visible(c),
            );
            if (profile && !connections.length) return null;
            return (
              <Card key={h.id} className="mb-3">
                <Card.Header>
                  <div className="d-flex justify-content-between gap-2 flex-wrap">
                    <div>
                      <strong>{h.name}</strong>{" "}
                      <small className="text-body-secondary">{h.url}</small>
                    </div>
                    {!profile && (
                      <div className="d-flex gap-1">
                        <Button
                          size="sm"
                          variant="outline-secondary"
                          disabled={busy}
                          onClick={() => openHost(h)}
                        >
                          Edit host
                        </Button>
                        <Button
                          size="sm"
                          variant="outline-secondary"
                          disabled={busy}
                          onClick={() => openHost(h, true)}
                        >
                          Add service
                        </Button>
                        <Button
                          size="sm"
                          variant="outline-danger"
                          disabled={busy}
                          onClick={() => void remove("hosts", h.id, h.name)}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="d-flex gap-3 mt-2 flex-wrap">
                    {profiles.map((p) => (
                      <Form.Check
                        key={p.id}
                        label={`All current connections · ${p.name}`}
                        checked={
                          connections.length > 0 &&
                          connections.every((c) => included(c.id, p.name))
                        }
                        disabled={busy || !connections.length}
                        onChange={(e) =>
                          toggle(connections, p.name, e.target.checked)
                        }
                      />
                    ))}
                  </div>
                </Card.Header>
                <Card.Body>
                  {!profile && (
                    <div className="d-flex gap-2 flex-wrap mb-3">
                      {services.map((n) => (
                        <div className="border rounded p-2" key={n.id}>
                          <Badge bg="secondary">{kinds[n.type]}</Badge>{" "}
                          <span>
                            {n.name} · {n.backendPath || "default"}
                            {n.type === "xui"
                              ? ` · inbound ${n.inboundId}`
                              : ""}
                          </span>{" "}
                          <Button
                            size="sm"
                            variant="link"
                            disabled={busy}
                            onClick={() => setService(n)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="link"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await post("sync", { ids: [n.id] });
                              })
                            }
                          >
                            Sync
                          </Button>
                          <Button
                            size="sm"
                            variant="link"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const r = await api<NodeTestResult>(
                                  `/nodes/${n.id}/test`,
                                  { method: "POST" },
                                );
                                const provider = {
                                  xui: r.xui,
                                  naive: r.caddy,
                                  shadowsocks: r.shadowsocks,
                                  mieru: r.mieru,
                                }[n.type];
                                setResults([
                                  {
                                    nodeId: n.id,
                                    name: n.name,
                                    ok: r.ok && provider?.ok !== false,
                                    error: r.error ?? provider?.error,
                                  },
                                ]);
                              })
                            }
                          >
                            Test
                          </Button>
                          <Button
                            size="sm"
                            variant="link"
                            className="text-danger"
                            disabled={busy}
                            onClick={() =>
                              void remove("services", n.id, n.name)
                            }
                          >
                            Delete
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {connections.length ? (
                    renderConnections(connections)
                  ) : (
                    <p className="text-body-secondary mb-0">
                      No connections. Add a connection or service to get
                      started.
                    </p>
                  )}
                </Card.Body>
              </Card>
            );
          })}
          {data.connections.some((c) => c.nodeId === null && visible(c)) && (
            <Card className="mb-3">
              <Card.Header>Unmanaged connections</Card.Header>
              <Card.Body>
                {renderConnections(
                  data.connections.filter(
                    (c) => c.nodeId === null && visible(c),
                  ),
                )}
              </Card.Body>
            </Card>
          )}
          {!data.connections.length && (
            <p className="text-body-secondary">No connections yet.</p>
          )}
          <div className="d-flex gap-2">
            <Button
              disabled={
                busy ||
                (!Object.keys(pending).length && !Object.keys(aliases).length)
              }
              onClick={() => void saveMemberships()}
            >
              {busy ? "Saving…" : "Save and sync"}
            </Button>
            <Button
              variant="outline-secondary"
              disabled={busy}
              onClick={() => {
                setPending({});
                setAliases({});
              }}
            >
              Discard changes
            </Button>
          </div>
        </Card.Body>
      </Card>
      <Modal
        show={host !== null}
        onHide={() => !busy && setHost(null)}
        size="lg"
        centered
        backdrop="static"
      >
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (!host) return;
              if (drafts.length)
                await post("setup", { host, services: drafts });
              else await post("hosts", host);
              setHost(null);
            });
          }}
        >
          <Modal.Header closeButton>
            <Modal.Title>
              {host?.id
                ? drafts.length
                  ? "Add services"
                  : "Edit host"
                : "Add host"}
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {error && <Alert variant="danger">{error}</Alert>}
            {host && (
              <>
                <Form.Label htmlFor="host-name">Host name</Form.Label>
                <Form.Control
                  id="host-name"
                  required
                  value={host.name}
                  onChange={(e) => setHost({ ...host, name: e.target.value })}
                />
                <Form.Label className="mt-2" htmlFor="host-url">
                  Agent URL
                </Form.Label>
                <Form.Control
                  id="host-url"
                  required
                  type="url"
                  placeholder="http://host:9000"
                  value={host.url}
                  onChange={(e) => setHost({ ...host, url: e.target.value })}
                />
                <Form.Label className="mt-2" htmlFor="host-secret">
                  Agent secret {host.id ? "(leave blank to keep)" : ""}
                </Form.Label>
                <Form.Control
                  id="host-secret"
                  type="password"
                  required={!host.id}
                  value={host.secret}
                  onChange={(e) => setHost({ ...host, secret: e.target.value })}
                />
                {(!host.id || drafts.length > 0) && (
                  <Button
                    className="mt-3"
                    variant="outline-secondary"
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        setBusy(true);
                        setError("");
                        try {
                          const r = await api<{
                            backends: {
                              name: string;
                              kind: NodeType;
                              path: string;
                            }[];
                          }>("/inventory/discover", {
                            method: "POST",
                            body: JSON.stringify(host),
                          });
                          setDrafts(
                            r.backends.map((b) => ({
                              ...newService(),
                              name: `${host.name} ${b.name}`,
                              type: b.kind,
                              path: b.path,
                              inboundId: b.kind === "xui" ? 1 : 0,
                            })),
                          );
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    Discover services
                  </Button>
                )}
                {drafts.length > 0 && (
                  <>
                    <hr />
                    <p>
                      Configure services and select profiles. All selections
                      apply to the services listed here.
                    </p>
                    <div className="d-flex gap-3 mb-3">
                      {data.profiles.map((p) => (
                        <Form.Check
                          key={p.id}
                          label={`All · ${p.name}`}
                          aria-label={`Include all services in ${p.name}`}
                          checked={drafts.every((d) =>
                            d.profiles.includes(p.name),
                          )}
                          onChange={(e) =>
                            setDrafts(
                              drafts.map((d) => ({
                                ...d,
                                profiles: e.target.checked
                                  ? [...new Set([...d.profiles, p.name])]
                                  : d.profiles.filter((n) => n !== p.name),
                              })),
                            )
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
                {drafts.map((d, i) => (
                  <Card key={i} className="mb-3">
                    <Card.Body>
                      <ServiceFields
                        value={d}
                        onChange={(v) =>
                          setDrafts(
                            drafts.map((x, j) =>
                              i === j ? { ...d, ...v } : x,
                            ),
                          )
                        }
                      />
                      <Form.Label className="mt-2">
                        Connection template
                      </Form.Label>
                      <Form.Control
                        as="textarea"
                        rows={3}
                        required
                        value={d.template}
                        placeholder="naive+https://{user}:{pass}@{ip}:443#Name"
                        onChange={(e) =>
                          setDrafts(
                            drafts.map((x, j) =>
                              i === j ? { ...d, template: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <div className="d-flex gap-3 mt-2">
                        {data.profiles.map((p) => (
                          <Form.Check
                            key={p.id}
                            label={p.name}
                            aria-label={`Include ${d.name || "service"} in ${p.name}`}
                            checked={d.profiles.includes(p.name)}
                            onChange={(e) =>
                              setDrafts(
                                drafts.map((x, j) =>
                                  i === j
                                    ? {
                                        ...d,
                                        profiles: e.target.checked
                                          ? [...d.profiles, p.name]
                                          : d.profiles.filter(
                                              (n) => n !== p.name,
                                            ),
                                      }
                                    : x,
                                ),
                              )
                            }
                          />
                        ))}
                      </div>
                      <Button
                        variant="link"
                        className="text-danger"
                        onClick={() =>
                          setDrafts(drafts.filter((_, j) => i !== j))
                        }
                      >
                        Remove service
                      </Button>
                    </Card.Body>
                  </Card>
                ))}
                {drafts.length > 0 && (
                  <Button
                    variant="outline-secondary"
                    onClick={() => setDrafts([...drafts, newService()])}
                  >
                    Add another service
                  </Button>
                )}
              </>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : drafts.length ? "Save and sync" : "Save host"}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
      <Modal
        show={connection !== null}
        onHide={() => !busy && setConnection(null)}
        size="lg"
        centered
        backdrop="static"
      >
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (!connection) return;
              await post("connections", {
                ...connection,
                id: connection.id || null,
              });
              setConnection(null);
            });
          }}
        >
          <Modal.Header closeButton>
            <Modal.Title>
              {connection?.id ? "Edit shared connection" : "New connection"}
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {error && <Alert variant="danger">{error}</Alert>}
            {connection && (
              <>
                {connection.id > 0 && (
                  <Alert variant="info">
                    Template and service changes apply to every profile using
                    this connection. Used by:{" "}
                    {data.memberships
                      .filter((m) => m.connectionId === connection.id)
                      .map((m) => m.profile)
                      .join(", ") || "none"}
                    .
                  </Alert>
                )}
                <Form.Label htmlFor="connection-name">Name</Form.Label>
                <Form.Control
                  id="connection-name"
                  required
                  value={connection.name}
                  onChange={(e) =>
                    setConnection({ ...connection, name: e.target.value })
                  }
                />
                <Form.Label className="mt-2" htmlFor="connection-service">
                  Managed service
                </Form.Label>
                <Form.Select
                  id="connection-service"
                  value={connection.nodeId ?? ""}
                  onChange={(e) =>
                    setConnection({
                      ...connection,
                      nodeId: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                >
                  <option value="">None · unmanaged link</option>
                  {data.services.map((n) => (
                    <option key={n.id} value={n.id}>
                      {data.hosts.find((h) => h.id === n.hostId)?.name} /{" "}
                      {n.name}
                    </option>
                  ))}
                </Form.Select>
                <Form.Label className="mt-2">Connection template</Form.Label>
                <Form.Control
                  as="textarea"
                  rows={4}
                  required
                  aria-label="Connection template"
                  value={connection.template}
                  onChange={(e) =>
                    setConnection({ ...connection, template: e.target.value })
                  }
                />
                <Form.Text>
                  Placeholders:{" "}
                  {"{ip}, {uuid}, {user}, {pass}, {sskey}, {mpass}"}. Use
                  “Create variant” for a different template in one profile.
                </Form.Text>
                <div className="d-flex gap-3 mt-3">
                  {data.profiles.map((p) => (
                    <Form.Check
                      key={p.id}
                      label={p.name}
                      checked={connection.profiles.includes(p.name)}
                      onChange={(e) =>
                        setConnection({
                          ...connection,
                          profiles: e.target.checked
                            ? [...connection.profiles, p.name]
                            : connection.profiles.filter((n) => n !== p.name),
                        })
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button type="submit" disabled={busy}>
              Save and sync
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
      <Modal
        show={service !== null}
        onHide={() => !busy && setService(null)}
        centered
        backdrop="static"
      >
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (!service) return;
              await post("services", {
                id: service.id,
                hostId: service.hostId,
                name: service.name,
                type: service.type,
                path: service.backendPath ?? "",
                inboundId: service.inboundId,
              });
              setService(null);
            });
          }}
        >
          <Modal.Header closeButton>
            <Modal.Title>Edit service</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {error && <Alert variant="danger">{error}</Alert>}
            {service && (
              <ServiceFields
                value={{ ...service, path: service.backendPath ?? "" }}
                onChange={(v) =>
                  setService({
                    ...service,
                    ...v,
                    backendPath: v.path ?? service.backendPath,
                  })
                }
              />
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button disabled={busy} type="submit">
              Save and sync
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </>
  );
}
function ServiceFields({
  value,
  onChange,
}: {
  value: { name: string; type: NodeType; path: string; inboundId: number };
  onChange: (value: Partial<DraftService>) => void;
}) {
  const id = useId();
  return (
    <>
      <Form.Label htmlFor={`${id}-name`}>Service name</Form.Label>
      <Form.Control
        id={`${id}-name`}
        required
        value={value.name}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <Form.Label className="mt-2" htmlFor={`${id}-type`}>
        Type
      </Form.Label>
      <Form.Select
        id={`${id}-type`}
        value={value.type}
        onChange={(e) => {
          const type = e.target.value as NodeType;
          onChange({
            type,
            path: `/${type === "shadowsocks" ? "ss2022" : type}`,
            inboundId: type === "xui" ? 1 : 0,
          });
        }}
      >
        {Object.entries(kinds).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </Form.Select>
      <Form.Label className="mt-2" htmlFor={`${id}-path`}>
        Backend path
      </Form.Label>
      <Form.Control
        id={`${id}-path`}
        placeholder="/naive (blank for default backend)"
        value={value.path}
        onChange={(e) => onChange({ path: e.target.value })}
      />
      {value.type === "xui" && (
        <>
          <Form.Label className="mt-2" htmlFor={`${id}-inbound`}>
            Inbound ID
          </Form.Label>
          <Form.Control
            required
            id={`${id}-inbound`}
            type="number"
            min={1}
            value={value.inboundId}
            onChange={(e) => onChange({ inboundId: Number(e.target.value) })}
          />
        </>
      )}
    </>
  );
}
