import { FormEvent, useEffect, useRef, useState } from "react";
import { Paginator } from "./Paginator";

import {
  Alert,
  Button,
  ButtonGroup,
  Card,
  Dropdown,
  Form,
  ListGroup,
  OverlayTrigger,
  Popover,
  Spinner,
  SplitButton,
  Table,
} from "react-bootstrap";
import {
  TbTrash as DeleteIcon,
  TbEdit as EditIcon,
  TbWifi as PingIcon,
  TbListCheck as SelectionIcon,
  TbArrowDown,
  TbArrowUp,
  TbCircleCheck,
  TbCircleX,
  TbCloudUpload,
  TbGripVertical,
  TbHelp,
} from "react-icons/tb";
import CodeMirror from "@uiw/react-codemirror";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type {
  ClientHttpPingResult,
  NodeRecord,
  NodeSyncUsersResult,
  PingResult,
  ServerFormState,
  ServerIcmpResult,
  ServerRecord,
  SyncConflictStrategy,
} from "../types";
import { ActionIconButton } from "./ActionIconButton";

const STRATEGY_LABELS: Record<SyncConflictStrategy, string> = {
  overwrite: "Overwrite",
  skip: "Skip existing",
  "keep-both": "Keep both",
  safe: "Safe (check first)",
};

/** true, если в шаблоне есть хоть какой-то плейсхолдер (именованный или легаси DUMMY). */
function hasPlaceholder(template: string): boolean {
  return /\{\w+\}/.test(template) || template.includes("DUMMY");
}

// CodeMirror renders its own caret as part of one text-layout model, unlike the old
// react-simple-code-editor approach (a transparent <textarea> pixel-overlaid on a
// separately-highlighted <pre>) — that dual-layer trick desyncs under line-wrapping
// because the highlighted layer's <mark> spans split the text into extra inline nodes,
// so a long wrapped line can pick a DIFFERENT wrap point than the plain-text layer,
// and every character after that point drifts. Decorations here just paint spans of
// the SAME single document, so there's no second layer to fall out of sync with.

const PLACEHOLDER_DECORATION = Decoration.mark({
  attributes: { style: "background:rgba(25,135,84,0.3);border-radius:2px" },
});
const WHITESPACE_DECORATION = Decoration.mark({
  attributes: { style: "background:rgba(255,193,7,0.45);border-radius:2px" },
});

// Named placeholders ({uuid}, {user}, {pass}, ...) and the legacy DUMMY alias — one
// regex, matching resolveTemplate on the backend (two passes would double-<mark> a
// name containing the substring DUMMY, e.g. {DUMMYnode}).
const placeholderMatcher = new MatchDecorator({
  regexp: /\{\w+\}|DUMMY/g,
  decoration: () => PLACEHOLDER_DECORATION,
});

const placeholderHighlighter = ViewPlugin.fromClass(
  class {
    placeholders: DecorationSet;
    constructor(view: EditorView) {
      this.placeholders = placeholderMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.placeholders = placeholderMatcher.updateDeco(update, this.placeholders);
    }
  },
  { decorations: (v) => v.placeholders },
);

/** Leading/trailing whitespace highlighted in amber to show it'll be trimmed on blur. */
function computeWhitespaceDecorations(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  const leading = /^\s+/.exec(text);
  const leadingEnd = leading ? leading[0].length : 0;
  if (leading) builder.add(0, leadingEnd, WHITESPACE_DECORATION);
  const trailing = /\s+$/.exec(text);
  if (trailing) {
    const trailingStart = text.length - trailing[0].length;
    // Guard against the all-whitespace case, where leading/trailing would overlap —
    // RangeSetBuilder requires strictly increasing, non-overlapping ranges.
    if (trailingStart >= leadingEnd) builder.add(trailingStart, text.length, WHITESPACE_DECORATION);
  }
  return builder.finish();
}

const whitespaceHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = computeWhitespaceDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = computeWhitespaceDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const templateEditorTheme = EditorView.theme({
  "&": { fontFamily: "monospace", fontSize: "inherit" },
  ".cm-content": { padding: "10px" },
  ".cm-scroller": { overflow: "auto" },
});

function TemplateTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <CodeMirror
      value={value}
      onChange={(v) => onChange(v.replace(/[\r\n]/g, ""))}
      onBlur={() => onChange(value.trim())}
      extensions={[EditorView.lineWrapping, placeholderHighlighter, whitespaceHighlighter, templateEditorTheme]}
      theme="none"
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
      }}
      className="form-control p-0 focus-ring-0"
      minHeight="6.5rem"
    />
  );
}

type ServersPanelProps = {
  editingServer: ServerRecord | null;
  httpResults: ClientHttpPingResult[];
  icmpResults: ServerIcmpResult[];
  nodes: NodeRecord[];
  onCancelEdit: () => void;
  onDeleteServer: (name: string) => void;
  onEditServer: (server: ServerRecord) => void;
  onPingAll: () => void;
  onReorder: (names: string[]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSyncUsersToServer: (serverName: string, strategy: SyncConflictStrategy) => Promise<NodeSyncUsersResult>;
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

const PLACEHOLDER_HELP = (
  <Popover id="placeholders-help" style={{ maxWidth: "26rem" }}>
    <Popover.Header as="h3">Плейсхолдеры в шаблоне</Popover.Header>
    <Popover.Body className="small">
      <p className="mb-2">
        Шаблон — это готовая ссылка, в которой креды пользователя подставляются на место
        плейсхолдеров. Каждому юзеру уходит своя копия.
      </p>
      <ul className="ps-3 mb-2">
        <li>
          <code>{"{uuid}"}</code> — идентификатор пользователя (VLESS).
          Легаси-алиас: <code>DUMMY</code> — работает как раньше.
        </li>
        <li>
          <code>{"{user}"}</code> — логин (NaïveProxy). Совпадает с именем клиента.
        </li>
        <li>
          <code>{"{pass}"}</code> — пароль (NaïveProxy). Генерируется автоматически при первой
          выдаче подписки и дальше не меняется.
        </li>
      </ul>
      <p className="mb-1 fw-semibold">Примеры</p>
      <div className="admin-code-wrap mb-1">
        <code>vless://{"{uuid}"}@1.2.3.4:443?security=reality&amp;sni=microsoft.com#node-1</code>
      </div>
      <div className="admin-code-wrap">
        <code>naive+https://{"{user}"}:{"{pass}"}@api.example.com:443#node-2</code>
      </div>
      <p className="mb-0 mt-2 text-body-secondary">
        Неизвестный плейсхолдер подставится пустой строкой — проверяй имена.
      </p>
    </Popover.Body>
  </Popover>
);

export function ServersPanel({
  editingServer,
  httpResults,
  icmpResults,
  nodes,
  onCancelEdit,
  onDeleteServer,
  onEditServer,
  onPingAll,
  onReorder,
  onSubmit,
  onSyncUsersToServer,
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragSrcIdx = useRef<number | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [syncStrategy, setSyncStrategy] = useState<SyncConflictStrategy>("overwrite");
  const [syncingServer, setSyncingServer] = useState<string | null>(null);
  const [syncResults, setSyncResults] = useState<Record<string, NodeSyncUsersResult | null>>({});

  async function handleSyncUsers(serverName: string) {
    setSyncingServer(serverName);
    try {
      const result = await onSyncUsersToServer(serverName, syncStrategy);
      setSyncResults((prev) => ({ ...prev, [serverName]: result }));
    } catch {
      setSyncResults((prev) => ({ ...prev, [serverName]: null }));
    } finally {
      setSyncingServer(null);
    }
  }

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

  // Reset to page 1 when search or page size changes
  useEffect(() => { setPage(1); }, [search, pageSize]);

  const paginatedServers =
    pageSize === 0
      ? filteredServers
      : filteredServers.slice((page - 1) * pageSize, page * pageSize);

  // Reorder needs paginatedServers to be the full, correctly-ordered servers array (index
  // N in the view = index N in the underlying array) — true whenever nothing is actually
  // filtered/paginated away, not just when pageSize's literal value is 0 ("All"). A small
  // list (fits on one page at the default page size) was wrongly hidden before this fix.
  const isDraggable = paginatedServers.length === servers.length;

  const allFilteredSelected =
    paginatedServers.length > 0 &&
    paginatedServers.every((s) => selectedServers.has(s.name));
  const someFilteredSelected = paginatedServers.some((s) =>
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
            <Form.Label>
              Template
              <OverlayTrigger trigger="click" rootClose placement="right" overlay={PLACEHOLDER_HELP}>
                {/* Нативная <button>, а не <span role=button>: клавиша Enter/Space
                    сама триггерит click, поэтому справка доступна с клавиатуры. */}
                <button
                  type="button"
                  className="btn btn-link p-0 border-0 align-baseline text-body-tertiary ms-1"
                  aria-label="Справка по плейсхолдерам"
                >
                  <TbHelp size={15} />
                </button>
              </OverlayTrigger>
            </Form.Label>
            <TemplateTextarea
              value={serverForm.template}
              onChange={(template) =>
                setServerForm({ ...serverForm, template })
              }
            />
            {serverForm.template.length > 0 && !hasPlaceholder(serverForm.template) && (
              <Alert variant="warning" className="mt-2 mb-0 py-2 small">
                В шаблоне нет плейсхолдеров (<code>{"{uuid}"}</code>, <code>{"{user}"}</code>,{" "}
                <code>{"{pass}"}</code> или легаси <code>DUMMY</code>) — все пользователи получат
                одну и ту же ссылку.
              </Alert>
            )}
          </Form.Group>

          {nodes.length > 0 && (
            <Form.Group className="mb-3" controlId="server-node">
              <Form.Label>Node (auto-sync)</Form.Label>
              <Form.Select
                value={serverForm.nodeId ?? ""}
                onChange={(e) =>
                  setServerForm({
                    ...serverForm,
                    nodeId: e.target.value ? parseInt(e.target.value, 10) : null,
                  })
                }
              >
                <option value="">— none —</option>
                {nodes.map((n) => {
                  const takenBy = servers.find(
                    (s) => s.nodeId === n.id && s.name !== editingServer?.name,
                  );
                  return (
                    <option key={n.id} value={n.id}>
                      {n.name} (inbound #{n.inboundId}){takenBy ? ` — also assigned to "${takenBy.name}"` : ""}
                    </option>
                  );
                })}
              </Form.Select>
              <Form.Text className="text-muted">
                When set, new users are automatically synced to this node.
              </Form.Text>
              {(() => {
                const sharedWith = serverForm.nodeId
                  ? servers.find((s) => s.nodeId === serverForm.nodeId && s.name !== editingServer?.name)
                  : null;
                return sharedWith ? (
                  <Alert variant="warning" className="mt-2 mb-0 py-2">
                    This node is already assigned to server &quot;{sharedWith.name}&quot; in this profile — both will
                    sync to the same physical node. That&apos;s fine if intentional (e.g. two link variants for the
                    same node), just know syncing either one pushes the same user list.
                  </Alert>
                ) : null;
              })()}
            </Form.Group>
          )}

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
                onToggleAllServers(paginatedServers.map((s) => s.name))
              }
              disabled={filteredServers.length === 0}
              title="Select / deselect all visible servers for ping"
              className="mb-0 text-nowrap"
            />
          )}
        </div>

        <ListGroup variant="flush">
          {paginatedServers.map((server, index) => (
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
                      disabled={index === paginatedServers.length - 1}
                    >
                      <TbArrowDown size={14} />
                    </button>
                  </div>
                )}
                <div className="admin-list-copy">
                  <div className="d-flex align-items-center gap-2 flex-wrap">
                    <span className="fw-semibold">{server.name}</span>
                    <PingBadge result={icmpByName[server.name]} label="ICMP" />
                    {server.nodeId !== null && (() => {
                      const node = nodes.find((n) => n.id === server.nodeId);
                      return node ? (
                        <span className="badge bg-info-subtle text-info-emphasis border border-info-subtle">
                          {node.name}
                        </span>
                      ) : null;
                    })()}
                  </div>
                  <div className="admin-code-wrap">
                    <code>{server.template}</code>
                  </div>
                  {server.nodeId !== null && (
                    <div className="d-flex align-items-center gap-2 flex-wrap mt-2">
                      <SplitButton
                        title={syncingServer === server.name
                          ? <Spinner size="sm" />
                          : <><TbCloudUpload size={14} className="me-1" />Sync users</>}
                        onClick={() => handleSyncUsers(server.name)}
                        variant="outline-secondary"
                        size="sm"
                        disabled={syncingServer === server.name}
                        id={`sync-users-${server.name}`}
                      >
                        {(Object.keys(STRATEGY_LABELS) as SyncConflictStrategy[]).map((s) => (
                          <Dropdown.Item key={s} active={syncStrategy === s} onClick={() => setSyncStrategy(s)}>
                            {STRATEGY_LABELS[s]}
                          </Dropdown.Item>
                        ))}
                      </SplitButton>
                      {syncResults[server.name] !== undefined && syncResults[server.name] !== null && (() => {
                        const r = syncResults[server.name]!;
                        if ("conflicts" in r) {
                          return (
                            <span className="text-danger small d-flex align-items-center gap-1">
                              <TbCircleX size={13} />
                              Conflicts: {r.conflicts.join(", ")}
                            </span>
                          );
                        }
                        return r.failed > 0 ? (
                          <span className="text-warning small d-flex align-items-center gap-1">
                            <TbCircleCheck size={13} />
                            {r.synced} synced, {r.failed} failed
                          </span>
                        ) : (
                          <span className="text-success small d-flex align-items-center gap-1">
                            <TbCircleCheck size={13} />
                            {r.synced} synced
                          </span>
                        );
                      })()}
                    </div>
                  )}
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

        <Paginator
          page={page}
          setPage={setPage}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
          totalCount={filteredServers.length}
        />

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
