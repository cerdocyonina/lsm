import { FormEvent, useEffect, useRef, useState } from "react";

import {
  Alert,
  Button,
  ButtonGroup,
  Card,
  Form,
  ListGroup,
  Spinner,
  Table,
} from "react-bootstrap";
import {
  TbTrash as DeleteIcon,
  TbEdit as EditIcon,
  TbWifi as PingIcon,
  TbListCheck as SelectionIcon,
  TbArrowDown,
  TbArrowUp,
  TbGripVertical,
} from "react-icons/tb";
import Editor from "react-simple-code-editor";
import type {
  ClientHttpPingResult,
  PingResult,
  ServerFormState,
  ServerIcmpResult,
  ServerRecord,
} from "../types";
import { ActionIconButton } from "./ActionIconButton";

function highlightTemplate(code: string): string {
  // Leading/trailing whitespace highlighted in amber to show it'll be trimmed on blur
  let result = code
    .replace(
      /^(\s+)/,
      `<mark style="background:rgba(255,193,7,0.45);border-radius:2px">$1</mark>`,
    )
    .replace(
      /(\s+)$/,
      `<mark style="background:rgba(255,193,7,0.45);border-radius:2px">$1</mark>`,
    );
  // DUMMY highlighted in green
  result = result.replace(
    /DUMMY/g,
    `<mark style="background:rgba(25,135,84,0.3);border-radius:2px;padding:0 1px">DUMMY</mark>`,
  );
  return result;
}

function TemplateTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Editor
      value={value}
      onValueChange={(v) => onChange(v.replace(/[\r\n]/g, ""))}
      highlight={highlightTemplate}
      padding={10}
      className="form-control"
      style={{
        fontFamily: "monospace",
        fontSize: "inherit",
        minHeight: "6.5rem",
      }}
      textareaClassName="focus-ring-0"
      onBlur={() => onChange(value.trim())}
    />
  );
}

type ServersPanelProps = {
  editingServer: ServerRecord | null;
  httpResults: ClientHttpPingResult[];
  icmpResults: ServerIcmpResult[];
  onCancelEdit: () => void;
  onDeleteServer: (name: string) => void;
  onEditServer: (server: ServerRecord) => void;
  onPingAll: () => void;
  onReorder: (names: string[]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pinging: boolean;
  savingServer: boolean;
  serverForm: ServerFormState;
  servers: ServerRecord[];
  setServerForm: (next: ServerFormState) => void;
  selectedServers: Set<string>;
  onToggleServer: (name: string) => void;
  onToggleAllServers: (visibleNames: string[]) => void;
  pingSelectionMode: boolean;
  onTogglePingSelection: () => void;
};

function PingBadge({
  result,
  label,
}: {
  result: PingResult | undefined;
  label: string;
}) {
  if (!result) {
    return (
      <span
        className="badge bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle"
        title={label}
      >
        {label} —
      </span>
    );
  }
  if (result.ok && result.latencyMs !== null) {
    return (
      <span
        className="badge bg-success-subtle text-success-emphasis border border-success-subtle"
        title={`${label}: ${result.latencyMs}ms`}
      >
        {label} {result.latencyMs}ms
      </span>
    );
  }
  return (
    <span
      className="badge bg-danger-subtle text-danger-emphasis border border-danger-subtle"
      title={`${label}: ${result.error ?? "failed"}`}
    >
      {label} ✗
    </span>
  );
}

function HttpResultCell({ result }: { result: PingResult }) {
  if (result.ok && result.latencyMs !== null) {
    return (
      <span
        className="text-success fw-semibold"
        title={`${result.latencyMs}ms`}
      >
        {result.latencyMs}ms
      </span>
    );
  }
  return (
    <span className="text-danger" title={result.error ?? "failed"}>
      ✗
    </span>
  );
}

export function ServersPanel({
  editingServer,
  httpResults,
  icmpResults,
  onCancelEdit,
  onDeleteServer,
  onEditServer,
  onPingAll,
  onReorder,
  onSubmit,
  pinging,
  savingServer,
  serverForm,
  servers,
  setServerForm,
  selectedServers,
  onToggleServer,
  onToggleAllServers,
  pingSelectionMode,
  onTogglePingSelection,
}: ServersPanelProps) {
  const [search, setSearch] = useState("");
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragSrcIdx = useRef<number | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const icmpByName = Object.fromEntries(
    icmpResults.map((r) => [r.serverName, r.icmp]),
  );

  const filteredServers = search.trim()
    ? servers.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          s.template.toLowerCase().includes(search.toLowerCase()),
      )
    : servers;

  const isDraggable = !search.trim();

  const allFilteredSelected =
    filteredServers.length > 0 &&
    filteredServers.every((s) => selectedServers.has(s.name));
  const someFilteredSelected = filteredServers.some((s) =>
    selectedServers.has(s.name),
  );

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        someFilteredSelected && !allFilteredSelected;
    }
  }, [someFilteredSelected, allFilteredSelected]);

  function handleDragStart(index: number) {
    dragSrcIdx.current = index;
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    setDragOverIdx(index);
  }

  function handleDrop(e: React.DragEvent, dstIdx: number) {
    e.preventDefault();
    setDragOverIdx(null);
    const srcIdx = dragSrcIdx.current;
    dragSrcIdx.current = null;
    if (srcIdx === null || srcIdx === dstIdx) return;
    const reordered = [...servers];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(dstIdx, 0, moved);
    onReorder(reordered.map((s) => s.name));
  }

  function handleDragEnd() {
    dragSrcIdx.current = null;
    setDragOverIdx(null);
  }

  function moveServer(fromIdx: number, toIdx: number) {
    const reordered = [...servers];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    onReorder(reordered.map((s) => s.name));
  }

  const showReorderColumn = isDraggable && servers.length > 1;

  // derive server name order from httpResults (consistent with server list)
  const httpServerNames =
    httpResults.length > 0
      ? (httpResults[0]?.servers.map((s) => s.serverName) ?? [])
      : [];

  return (
    <Card className="shadow-sm h-100">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-4">
          <div>
            <div className="text-uppercase text-muted small fw-semibold mb-1">
              Servers
            </div>
            <h2 className="h5 mb-0">
              {editingServer ? "Edit server" : "Create server"}
            </h2>
          </div>
          <ButtonGroup>
            <Button
              variant="outline-secondary"
              type="button"
              onClick={onPingAll}
              disabled={pinging || servers.length === 0}
              className="d-flex align-items-center gap-1"
            >
              {pinging ? <Spinner size="sm" /> : <PingIcon size={16} />}
              {pinging
                ? "Pinging…"
                : pingSelectionMode
                  ? "Ping selected"
                  : "Ping all"}
            </Button>
            <Button
              variant={pingSelectionMode ? "secondary" : "outline-secondary"}
              type="button"
              onClick={onTogglePingSelection}
              title="Select servers / users to ping"
              aria-pressed={pingSelectionMode}
            >
              <SelectionIcon size={16} />
            </Button>
          </ButtonGroup>
        </div>

        <Form onSubmit={onSubmit}>
          <Form.Group className="mb-3" controlId="server-name">
            <Form.Label>Name</Form.Label>
            <Form.Control
              required
              value={serverForm.name}
              onChange={(event) =>
                setServerForm({
                  ...serverForm,
                  name: event.target.value,
                })
              }
            />
          </Form.Group>

          <Form.Group className="mb-3" controlId="server-template">
            <Form.Label>Template</Form.Label>
            <TemplateTextarea
              value={serverForm.template}
              onChange={(template) =>
                setServerForm({ ...serverForm, template })
              }
            />
            {serverForm.template.length > 0 &&
              !serverForm.template.includes("DUMMY") && (
                <Alert variant="warning" className="mt-2 mb-0 py-2 small">
                  Template doesn't include <code>DUMMY</code> — the user UUID
                  won't be substituted.
                </Alert>
              )}
          </Form.Group>

          <div className="d-flex gap-2">
            <Button type="submit" disabled={savingServer}>
              {savingServer
                ? "Saving..."
                : editingServer
                  ? "Update server"
                  : "Add server"}
            </Button>
            {editingServer ? (
              <Button
                variant="outline-secondary"
                type="button"
                onClick={onCancelEdit}
              >
                Cancel edit
              </Button>
            ) : null}
          </div>
        </Form>

        <hr className="my-4" />

        <div className="d-flex align-items-center gap-2 mb-3">
          <Form.Group className="flex-grow-1 mb-0" controlId="server-search">
            <Form.Control
              type="search"
              placeholder="Search by name or template…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Form.Group>
          {pingSelectionMode && (
            <Form.Check
              ref={selectAllRef}
              type="checkbox"
              id="server-select-all"
              label="All"
              checked={allFilteredSelected}
              onChange={() =>
                onToggleAllServers(filteredServers.map((s) => s.name))
              }
              disabled={filteredServers.length === 0}
              title="Select / deselect all visible servers for ping"
              className="mb-0 text-nowrap"
            />
          )}
        </div>

        <ListGroup variant="flush">
          {filteredServers.map((server, index) => (
            <ListGroup.Item
              className={`px-0 py-3${dragOverIdx === index ? " bg-body-secondary" : ""}`}
              key={server.name}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
            >
              <div
                className="admin-list-item"
                style={
                  showReorderColumn && pingSelectionMode
                    ? { gridTemplateColumns: "auto auto minmax(0,1fr) auto" }
                    : pingSelectionMode || showReorderColumn
                      ? { gridTemplateColumns: "auto minmax(0,1fr) auto" }
                      : undefined
                }
              >
                {pingSelectionMode && (
                  <Form.Check
                    type="checkbox"
                    id={`server-sel-${server.name}`}
                    aria-label={`Select ${server.name}`}
                    checked={selectedServers.has(server.name)}
                    onChange={() => onToggleServer(server.name)}
                    className="d-flex align-items-center mb-0"
                    title="Select / deselect server for ping"
                  />
                )}
                {showReorderColumn && (
                  <div
                    className="text-body-tertiary d-flex flex-column align-items-center"
                    style={{ touchAction: "none" }}
                  >
                    <div
                      draggable
                      style={{ cursor: "grab" }}
                      onDragStart={(e) => {
                        const row = e.currentTarget.closest(
                          ".list-group-item",
                        ) as HTMLElement | null;
                        if (row) e.dataTransfer.setDragImage(row, 0, 20);
                        handleDragStart(index);
                      }}
                    >
                      <TbGripVertical size={18} />
                    </div>

                    <button
                      type="button"
                      className="btn btn-link p-0 text-body-tertiary"
                      style={{ lineHeight: 1 }}
                      onClick={() => moveServer(index, index - 1)}
                      title="Move up"
                      disabled={index === 0}
                    >
                      <TbArrowUp size={14} />
                    </button>

                    <button
                      type="button"
                      className="btn btn-link p-0 text-body-tertiary"
                      style={{ lineHeight: 1 }}
                      onClick={() => moveServer(index, index + 1)}
                      title="Move down"
                      disabled={index === filteredServers.length - 1}
                    >
                      <TbArrowDown size={14} />
                    </button>
                  </div>
                )}
                <div className="admin-list-copy">
                  <div className="d-flex align-items-center gap-2 flex-wrap">
                    <span className="fw-semibold">{server.name}</span>
                    <PingBadge result={icmpByName[server.name]} label="ICMP" />
                  </div>
                  <div className="admin-code-wrap">
                    <code>{server.template}</code>
                  </div>
                  <div className="admin-meta">
                    <small className="text-muted">
                      {new Date(server.createdAt).toLocaleString("ru-RU", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                      })}
                    </small>
                  </div>
                </div>
                <div className="admin-actions-grid">
                  <ActionIconButton
                    size="sm"
                    icon={<EditIcon />}
                    label="Edit server"
                    onClick={() => onEditServer(server)}
                    variant="outline-primary"
                  />
                  <ActionIconButton
                    size="sm"
                    icon={<DeleteIcon />}
                    label="Delete server"
                    onClick={() => onDeleteServer(server.name)}
                    variant="outline-danger"
                  />
                </div>
              </div>
            </ListGroup.Item>
          ))}
        </ListGroup>

        {httpResults.length > 0 && (
          <>
            <hr className="my-4" />
            <div className="text-uppercase text-muted small fw-semibold mb-2">
              HTTP ping results
            </div>
            <div style={{ overflowX: "auto" }}>
              <Table
                size="sm"
                bordered
                className="mb-0"
                style={{ fontSize: "0.8rem" }}
              >
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>UUID</th>
                    {httpServerNames.map((name) => (
                      <th key={name}>{name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {httpResults.map((row) => (
                    <tr key={row.clientName}>
                      <td className="fw-semibold">{row.clientName}</td>
                      <td>
                        <code style={{ fontSize: "0.75rem" }}>
                          {row.userUuid}
                        </code>
                      </td>
                      {row.servers.map((s) => (
                        <td key={s.serverName} className="text-center">
                          <HttpResultCell result={s.result} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        )}
      </Card.Body>
    </Card>
  );
}
