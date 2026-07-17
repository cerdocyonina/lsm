import { FormEvent, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Form,
  InputGroup,
  ListGroup,
  OverlayTrigger,
  Spinner,
  Tooltip,
} from "react-bootstrap";
import { TbCircleCheck, TbCircleX, TbEdit, TbExclamationCircle, TbHelp, TbTrash, TbWifi } from "react-icons/tb";
import type { NodeFormState, NodeRecord, NodeTestResult, NodeType } from "../types";
import { ActionIconButton } from "./ActionIconButton";

type NodesPanelProps = {
  nodes: NodeRecord[];
  onAddNode: (form: NodeFormState) => Promise<void>;
  onUpdateNode: (id: number, form: NodeFormState) => Promise<void>;
  onDeleteNode: (id: number, name: string) => Promise<void>;
  onTestNode: (id: number) => Promise<NodeTestResult>;
};

function emptyForm(): NodeFormState {
  return { name: "", url: "", secret: "", inboundId: "", type: "xui" };
}

function FieldHint({ id, text }: { id: string; text: string }) {
  return (
    <OverlayTrigger placement="top" overlay={<Tooltip id={id}>{text}</Tooltip>}>
      <span className="text-body-tertiary ms-1" role="button" tabIndex={0} aria-label={text}>
        <TbHelp size={14} />
      </span>
    </OverlayTrigger>
  );
}

/** Под-статус провайдера приходит в поле xui (3x-ui-ноды) или caddy (naive-ноды). */
function providerStatus(node: NodeRecord, result: NodeTestResult) {
  const status = node.type === "naive" ? result.caddy : result.xui;
  return status ? { status, label: node.type === "naive" ? "Caddy" : "3x-ui" } : null;
}

export function NodesPanel({ nodes, onAddNode, onUpdateNode, onDeleteNode, onTestNode }: NodesPanelProps) {
  const [form, setForm] = useState<NodeFormState>(emptyForm());
  const [editingNode, setEditingNode] = useState<NodeRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [pingingAll, setPingingAll] = useState(false);
  const [testResults, setTestResults] = useState<Record<number, NodeTestResult | null>>({});

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editingNode) {
        await onUpdateNode(editingNode.id, form);
      } else {
        await onAddNode(form);
      }
      setForm(emptyForm());
      setEditingNode(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save node.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(id: number) {
    setTestingId(id);
    try {
      const result = await onTestNode(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch {
      setTestResults((prev) => ({ ...prev, [id]: { ok: false } }));
    } finally {
      setTestingId(null);
    }
  }

  async function handlePingAll() {
    setPingingAll(true);
    await Promise.allSettled(
      nodes.map(async (node) => {
        try {
          const result = await onTestNode(node.id);
          setTestResults((prev) => ({ ...prev, [node.id]: result }));
        } catch {
          setTestResults((prev) => ({ ...prev, [node.id]: { ok: false } }));
        }
      }),
    );
    setPingingAll(false);
  }

  function startEdit(node: NodeRecord) {
    setEditingNode(node);
    setForm({ name: node.name, url: node.url, secret: "", inboundId: String(node.inboundId), type: node.type });
    setError(null);
  }

  function cancelEdit() {
    setEditingNode(null);
    setForm(emptyForm());
    setError(null);
  }

  return (
    <Card className="shadow-sm">
      <Card.Body>
        <div className="d-flex justify-content-between align-items-start mb-4">
          <div>
            <div className="text-uppercase text-muted small fw-semibold mb-1">Nodes</div>
            <h2 className="h5 mb-0">{editingNode ? "Edit node" : "Add node"}</h2>
          </div>
          {editingNode && (
            <Button variant="outline-secondary" size="sm" onClick={cancelEdit}>
              Cancel edit
            </Button>
          )}
        </div>

        {error && <Alert variant="danger" className="mb-3">{error}</Alert>}

        <Form onSubmit={handleSubmit}>
          <div className="row g-2 mb-3">
            <div className="col-sm-6">
              <Form.Group controlId="node-name">
                <Form.Label>
                  Name
                  <FieldHint id="hint-node-name" text="Произвольное имя узла — только для тебя, в ссылки не попадает." />
                </Form.Label>
                <Form.Control
                  required
                  placeholder="node-1"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Form.Group>
            </div>
            <div className="col-sm-6">
              <Form.Group controlId="node-type">
                <Form.Label>
                  Type
                  <FieldHint
                    id="hint-node-type"
                    text="Чем управляет агент на узле: панелью 3x-ui (VLESS) или Caddy с NaiveProxy."
                  />
                </Form.Label>
                <Form.Select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as NodeType })}
                >
                  <option value="xui">3x-ui (VLESS)</option>
                  <option value="naive">NaïveProxy (Caddy)</option>
                </Form.Select>
              </Form.Group>
            </div>
          </div>

          {form.type === "xui" ? (
            <Form.Group className="mb-3" controlId="node-inbound-id">
              <Form.Label>
                Inbound ID
                <FieldHint id="hint-node-inbound" text="ID инбаунда в панели 3x-ui, куда агент добавляет клиентов." />
              </Form.Label>
              <Form.Control
                required
                type="number"
                min="1"
                placeholder="1"
                value={form.inboundId}
                onChange={(e) => setForm({ ...form, inboundId: e.target.value })}
              />
            </Form.Group>
          ) : (
            <Alert variant="secondary" className="mb-3 py-2 small">
              У NaïveProxy нет инбаундов. Агент управляет юзерами прямо в конфиге Caddy: пушит
              весь список и делает <code>caddy reload</code>. Пути и имя контейнера настраиваются
              в <code>.env</code> самого агента (<code>CADDY_USERS_FILE</code>, <code>CADDY_CONTAINER</code>).
            </Alert>
          )}

          <Form.Group className="mb-3" controlId="node-url">
            <Form.Label>
              URL
              <FieldHint id="hint-node-url" text="Адрес агента lsm-node на узле, например http://1.2.3.4:9000" />
            </Form.Label>
            <Form.Control
              required
              type="url"
              placeholder="http://node1.example.com:9000"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </Form.Group>

          <Form.Group className="mb-3" controlId="node-secret">
            <Form.Label>
              Shared secret
              <FieldHint id="hint-node-secret" text="Должен совпадать с SHARED_SECRET в .env агента." />
              {editingNode && <span className="text-muted fw-normal ms-1 small">(leave blank to keep current)</span>}
            </Form.Label>
            <Form.Control
              required={!editingNode}
              type="password"
              autoComplete="new-password"
              value={form.secret}
              onChange={(e) => setForm({ ...form, secret: e.target.value })}
            />
          </Form.Group>

          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : editingNode ? "Update node" : "Add node"}
          </Button>
        </Form>

        {nodes.length > 0 && (
          <>
            <hr className="my-4" />
            <div className="d-flex justify-content-end mb-2">
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={() => { void handlePingAll(); }}
                disabled={pingingAll || testingId !== null}
              >
                {pingingAll ? <><Spinner size="sm" className="me-1" />Pinging…</> : <><TbWifi size={14} className="me-1" />Ping all</>}
              </Button>
            </div>
            <ListGroup variant="flush">
              {nodes.map((node) => {
                const testResult = testResults[node.id];
                return (
                  <ListGroup.Item className="px-0 py-3" key={node.id}>
                    <div className="d-flex align-items-start gap-2">
                      <div className="flex-grow-1 min-w-0">
                        <div className="d-flex align-items-center gap-2 flex-wrap mb-1">
                          <span className="fw-semibold">{node.name}</span>
                          {node.type === "naive" ? (
                            <Badge bg="secondary" className="font-monospace fw-normal">naive</Badge>
                          ) : (
                            <Badge bg="secondary" className="font-monospace fw-normal">
                              inbound #{node.inboundId}
                            </Badge>
                          )}
                          {testResult?.ok === true && (() => {
                            const provider = providerStatus(node, testResult);
                            const degraded = provider !== null && !provider.status.ok;
                            return (
                              <span className="small d-flex align-items-center gap-2 flex-wrap">
                                <span className={`d-flex align-items-center gap-1 ${degraded ? "text-warning" : "text-success"}`}>
                                  {degraded ? <TbExclamationCircle size={14} /> : <TbCircleCheck size={14} />}
                                  <span>Online</span>
                                  {testResult.version && (
                                    <Badge bg={degraded ? "warning" : "success"} className="fw-normal" style={{ fontSize: "0.7em" }}>
                                      v{testResult.version}
                                    </Badge>
                                  )}
                                  {testResult.commit && (
                                    <code className={degraded ? "text-warning" : "text-success"} style={{ fontSize: "0.75em" }}>
                                      {testResult.commit}
                                    </code>
                                  )}
                                  {testResult.date && (
                                    <span className="text-body-secondary" style={{ fontSize: "0.75em" }}>{testResult.date}</span>
                                  )}
                                </span>
                                {provider && (
                                  <span className={`d-flex align-items-center gap-1 ${provider.status.ok ? "text-success" : "text-danger"}`}>
                                    {provider.status.ok ? (
                                      <><TbCircleCheck size={14} /><span>{provider.label} OK</span></>
                                    ) : (
                                      <><TbCircleX size={14} /><span title={provider.status.error}>{provider.label} unreachable</span></>
                                    )}
                                  </span>
                                )}
                              </span>
                            );
                          })()}
                          {testResult?.ok === false && (
                            <span className="text-danger small d-flex align-items-center gap-1">
                              <TbCircleX size={14} /> unreachable
                            </span>
                          )}
                        </div>
                        <div className="text-body-secondary small">
                          <code>{node.url}</code>
                        </div>
                      </div>
                      <div className="d-flex gap-1 flex-shrink-0">
                        <Button
                          variant="outline-secondary"
                          size="sm"
                          onClick={() => handleTest(node.id)}
                          disabled={testingId === node.id || pingingAll}
                          title="Test connection"
                        >
                          {testingId === node.id ? <Spinner size="sm" /> : <TbWifi size={14} />}
                        </Button>
                        <ActionIconButton
                          size="sm"
                          icon={<TbEdit />}
                          label="Edit node"
                          onClick={() => startEdit(node)}
                          variant="outline-primary"
                        />
                        <ActionIconButton
                          size="sm"
                          icon={<TbTrash />}
                          label="Delete node"
                          onClick={() => onDeleteNode(node.id, node.name)}
                          variant="outline-danger"
                        />
                      </div>
                    </div>
                  </ListGroup.Item>
                );
              })}
            </ListGroup>
          </>
        )}
      </Card.Body>
    </Card>
  );
}
