import { useRef, useState } from "react";
import { Badge, Button, ButtonGroup, Card, Form, ListGroup, Modal, Spinner, Table } from "react-bootstrap";
import toast from "react-hot-toast";
import {
  TbArrowDown,
  TbArrowUp,
  TbEdit,
  TbGripVertical,
  TbListCheck,
  TbPencil,
  TbPlus,
  TbWifi,
  TbX,
} from "react-icons/tb";
import { api, profilePath } from "../api";
import { KindBadge, labelOf, type InventoryApi, type ServerDraft } from "../inventory";
import type { ClientHttpPingResult, PingResult, ServerIcmpResult } from "../types";
import { ActionIconButton } from "./ActionIconButton";
import { SelectionBar } from "./SelectionBar";
import { ServerEditor } from "./ServerEditor";

function PingBadge({ result }: { result: PingResult | undefined }) {
  if (!result) return null;
  if (result.ok && result.latencyMs !== null)
    return (
      <span className="badge bg-success-subtle text-success-emphasis border border-success-subtle fw-normal">
        {result.latencyMs} ms
      </span>
    );
  return (
    <span
      className="badge bg-danger-subtle text-danger-emphasis border border-danger-subtle fw-normal"
      title={result.error ?? "failed"}
    >
      ICMP ✗
    </span>
  );
}

type Props = {
  profile: string;
  inv: InventoryApi;
  icmp: ServerIcmpResult[];
  http: ClientHttpPingResult[];
  pinging: boolean;
  selectionMode: boolean;
  selected: Set<string>;
  onToggleSelectionMode: () => void;
  onToggleServer: (name: string) => void;
  onSelectServers: (next: Set<string>) => void;
  onPing: () => void;
};

/** What this profile's subscribers get, in order: labels, reorder, ping, add/remove. */
export function ProfileServersPanel({
  profile,
  inv,
  icmp,
  http,
  pinging,
  selectionMode,
  selected,
  onToggleSelectionMode,
  onToggleServer,
  onSelectServers,
  onPing,
}: Props) {
  const { data } = inv;
  const [editor, setEditor] = useState<ServerDraft | null>(null);
  const [picker, setPicker] = useState<Set<number> | null>(null);
  const [label, setLabel] = useState<{ name: string; value: string } | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);

  const members = data.memberships
    .filter((m) => m.profile === profile)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const rows = (order ? order.map((n) => members.find((m) => m.name === n)!).filter(Boolean) : members).map((m) => {
    const c = data.connections.find((x) => x.id === m.connectionId)!;
    const service = inv.service(c?.nodeId ?? null);
    const host = data.hosts.find((h) => h.id === service?.hostId);
    return { m, c, service, host };
  });
  const names = rows.map((r) => r.m.name);

  async function reorder(next: string[]) {
    setOrder(next);
    try {
      await api(profilePath(profile, "/servers/order"), { method: "PUT", body: JSON.stringify({ order: next }) });
      await inv.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setOrder(null);
    }
  }
  function move(from: number, to: number) {
    if (to < 0 || to >= names.length || from === to) return;
    const next = [...names];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    void reorder(next);
  }

  async function saveLabel(name: string, value: string, template: string) {
    const trimmed = value.trim();
    // Typing the template's own label back means "no override".
    const displayName = !trimmed || trimmed === labelOf(template) ? null : trimmed;
    try {
      await api(profilePath(profile, `/servers/${encodeURIComponent(name)}`), {
        method: "PATCH",
        body: JSON.stringify({ displayName }),
      });
      setLabel(null);
      await inv.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function remove(id: number, name: string) {
    if (!window.confirm(`Remove ${name} from ${profile}? Its users lose this server and are revoked on the agent.`))
      return;
    void inv.setIncluded(id, profile, false);
  }

  const available = data.connections.filter((c) => !members.some((m) => m.connectionId === c.id));
  const groups = [
    ...data.hosts.map((h) => ({
      key: `h${h.id}`,
      title: h.name,
      items: available.filter((c) => inv.service(c.nodeId)?.hostId === h.id),
    })),
    { key: "none", title: "Links without an agent", items: available.filter((c) => c.nodeId === null) },
  ].filter((g) => g.items.length);

  return (
    <Card className="shadow-sm">
      <Card.Body>
        <div className="d-flex justify-content-between align-items-start gap-2 flex-wrap mb-2">
          <div>
            <h2 className="h5 mb-0">Servers</h2>
            <div className="small text-body-secondary">
              What <strong>{profile}</strong> subscribers get, top to bottom.
            </div>
          </div>
          <div className="d-flex gap-2">
            <ButtonGroup size="sm">
              <Button variant="outline-secondary" onClick={onPing} disabled={pinging || !rows.length}>
                {pinging ? <Spinner size="sm" className="me-1" /> : <TbWifi className="me-1" />}
                {selectionMode ? "Ping selected" : "Ping all"}
              </Button>
              <Button
                variant={selectionMode ? "secondary" : "outline-secondary"}
                onClick={onToggleSelectionMode}
                title="Choose servers and users to ping"
                aria-pressed={selectionMode}
              >
                <TbListCheck />
              </Button>
            </ButtonGroup>
            <Button size="sm" onClick={() => setPicker(new Set())}>
              <TbPlus className="me-1" />
              Add servers
            </Button>
          </div>
        </div>

        {selectionMode && rows.length > 0 && (
          <SelectionBar
            id="server-select-all"
            noun="servers"
            allNames={names}
            matchingNames={names}
            filterActive={false}
            selected={selected}
            onChange={onSelectServers}
          />
        )}

        {!rows.length && (
          <div className="text-center text-body-secondary py-4 small">
            No servers in this profile yet. <strong>Add servers</strong> picks from the ones on the Servers page.
          </div>
        )}

        <ListGroup variant="flush">
          {rows.map(({ m, c, service, host }, i) => {
            const templateLabel = labelOf(c.template);
            const shown = m.displayName ?? templateLabel;
            const editing = label?.name === m.name;
            return (
              <ListGroup.Item
                key={m.name}
                className={`px-0 py-2${dragOver === i ? " bg-body-secondary" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  if (dragFrom.current !== null) move(dragFrom.current, i);
                  dragFrom.current = null;
                }}
                onDragEnd={() => {
                  dragFrom.current = null;
                  setDragOver(null);
                }}
              >
                <div className={`profile-server-row${selectionMode ? " with-select" : ""}`}>
                  {selectionMode && (
                    <Form.Check
                      aria-label={`Select ${c.name} for ping`}
                      checked={selected.has(m.name)}
                      onChange={() => onToggleServer(m.name)}
                      className="mb-0"
                    />
                  )}
                  <div className="d-flex flex-column align-items-center text-body-tertiary" style={{ width: 18 }}>
                    <button
                      type="button"
                      className="btn btn-link p-0 text-body-tertiary lh-1"
                      aria-label={`Move ${c.name} up`}
                      disabled={i === 0 || order !== null}
                      onClick={() => move(i, i - 1)}
                    >
                      <TbArrowUp size={13} />
                    </button>
                    <span
                      draggable={order === null}
                      style={{ cursor: "grab" }}
                      title="Drag to reorder"
                      onDragStart={(e) => {
                        const row = e.currentTarget.closest(".list-group-item") as HTMLElement | null;
                        if (row) e.dataTransfer.setDragImage(row, 0, 20);
                        dragFrom.current = i;
                      }}
                    >
                      <TbGripVertical size={16} />
                    </span>
                    <button
                      type="button"
                      className="btn btn-link p-0 text-body-tertiary lh-1"
                      aria-label={`Move ${c.name} down`}
                      disabled={i === rows.length - 1 || order !== null}
                      onClick={() => move(i, i + 1)}
                    >
                      <TbArrowDown size={13} />
                    </button>
                  </div>
                  <div className="min-w-0">
                    <div className="d-flex align-items-center gap-2 flex-wrap">
                      <span className="fw-semibold">{c.name}</span>
                      {service ? <KindBadge type={service.type} /> : null}
                      <small className="text-body-secondary">{host?.name ?? "link only"}</small>
                      <PingBadge result={icmp.find((r) => r.serverName === m.name)?.icmp} />
                    </div>
                    {editing ? (
                      <Form
                        className="d-flex gap-1 mt-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveLabel(m.name, label.value, c.template);
                        }}
                      >
                        <Form.Control
                          size="sm"
                          autoFocus
                          aria-label={`Label of ${c.name} in ${profile}`}
                          value={label.value}
                          placeholder={templateLabel ?? "label"}
                          onChange={(e) => setLabel({ name: m.name, value: e.target.value })}
                          onKeyDown={(e) => e.key === "Escape" && setLabel(null)}
                        />
                        <Button size="sm" type="submit">
                          Save
                        </Button>
                        <Button size="sm" variant="outline-secondary" onClick={() => setLabel(null)}>
                          Cancel
                        </Button>
                      </Form>
                    ) : (
                      <div className="small d-flex align-items-center gap-1 min-w-0">
                        <span className="text-body-secondary text-truncate" title="Label clients see">
                          {shown ?? <em>no label</em>}
                        </span>
                        {m.displayName !== null && (
                          <Badge
                            bg="info-subtle"
                            text="info-emphasis"
                            className="fw-normal border border-info-subtle"
                            title={`Only in ${profile}. The template says: ${templateLabel ?? "(nothing)"}`}
                          >
                            {profile} only
                          </Badge>
                        )}
                        <button
                          type="button"
                          className="btn btn-link p-0 text-body-tertiary lh-1"
                          aria-label={`Change label of ${c.name} in ${profile}`}
                          title={
                            service?.type === "mieru"
                              ? "mieru clients show the profile= name from the template, not this label"
                              : `Change the label for ${profile} only`
                          }
                          onClick={() => setLabel({ name: m.name, value: shown ?? "" })}
                        >
                          <TbPencil size={13} />
                        </button>
                        {m.displayName !== null && (
                          <button
                            type="button"
                            className="btn btn-link p-0 small text-body-tertiary"
                            onClick={() => void saveLabel(m.name, "", c.template)}
                          >
                            reset
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="d-flex gap-1">
                    <ActionIconButton
                      variant="outline-secondary"
                      label={`Edit ${c.name} (all profiles)`}
                      icon={<TbEdit size={16} />}
                      onClick={() => setEditor(inv.draftOf(c))}
                    />
                    <ActionIconButton
                      variant="outline-danger"
                      label={`Remove ${c.name} from ${profile}`}
                      icon={inv.busy === `chip:${c.id}:${profile}` ? <Spinner size="sm" /> : <TbX size={16} />}
                      disabled={inv.busy !== null}
                      onClick={() => remove(c.id, c.name)}
                    />
                  </div>
                </div>
              </ListGroup.Item>
            );
          })}
        </ListGroup>

        {http.length > 0 && (
          <>
            <h3 className="h6 mt-4">HTTP through the proxy</h3>
            <Table size="sm" responsive className="small mb-0">
              <thead>
                <tr>
                  <th>User</th>
                  {http[0]!.servers.map((s) => (
                    <th key={s.serverName}>{s.serverName}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {http.map((u) => (
                  <tr key={u.clientName}>
                    <td>{u.clientName}</td>
                    {u.servers.map((s) => (
                      <td key={s.serverName}>
                        {s.result.ok ? (
                          <span className="text-success">{s.result.latencyMs} ms</span>
                        ) : (
                          <span className="text-danger" title={s.result.error}>
                            ✗
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card.Body>

      <Modal show={picker !== null} onHide={() => setPicker(null)} centered scrollable>
        <Modal.Header closeButton>
          <Modal.Title className="h5">Add servers to {profile}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {!groups.length && <p className="text-body-secondary mb-0">Every server is already in this profile.</p>}
          {groups.map((g) => (
            <div key={g.key} className="mb-3">
              <div className="small fw-semibold text-body-secondary mb-1">{g.title}</div>
              {g.items.map((c) => {
                const s = inv.service(c.nodeId);
                const used = inv.profilesOf(c.id);
                return (
                  <Form.Check
                    key={c.id}
                    id={`pick-${c.id}`}
                    className="mb-1"
                    checked={picker?.has(c.id) ?? false}
                    onChange={(e) =>
                      setPicker((old) => {
                        const next = new Set(old);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                    label={
                      <span className="d-inline-flex align-items-center gap-2 flex-wrap">
                        <span>{c.name}</span>
                        {s && <KindBadge type={s.type} />}
                        <small className="text-body-secondary">
                          {labelOf(c.template) ?? ""}
                          {used.length ? ` · in ${used.join(", ")}` : " · unused"}
                        </small>
                      </span>
                    }
                  />
                );
              })}
            </div>
          ))}
        </Modal.Body>
        <Modal.Footer className="justify-content-between">
          <Button
            variant="link"
            className="px-0"
            onClick={() => {
              setPicker(null);
              setEditor({ id: null, name: "", template: "", target: null, profiles: [profile] });
            }}
          >
            Create a new server…
          </Button>
          <div className="d-flex gap-2">
            <Button variant="outline-secondary" onClick={() => setPicker(null)}>
              Cancel
            </Button>
            <Button
              disabled={!picker?.size || inv.busy !== null}
              onClick={async () => {
                const ids = [...(picker ?? [])];
                const r = await inv.attempt("pick", "/inventory/assignments", {
                  assignments: ids.map((connectionId) => ({ connectionId, profile, included: true })),
                });
                if (r) setPicker(null);
              }}
            >
              {inv.busy === "pick" ? "Adding…" : `Add ${picker?.size || ""}`}
            </Button>
          </div>
        </Modal.Footer>
      </Modal>

      <ServerEditor draft={editor} data={data} onSave={inv.saveServer} onClose={() => setEditor(null)} />
    </Card>
  );
}
