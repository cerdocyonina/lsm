import { FormEvent, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dropdown,
  Form,
  InputGroup,
  ListGroup,
  Spinner,
  SplitButton,
} from "react-bootstrap";
import { TbCircleCheck, TbCircleX, TbCloudUpload, TbEdit, TbTrash, TbWifi } from "react-icons/tb";
import type { NodeFormState, NodeRecord, NodeSyncUsersResult, NodeTestResult, SyncConflictStrategy } from "../types";
import { ActionIconButton } from "./ActionIconButton";

type NodesPanelProps = {
  nodes: NodeRecord[];
  onAddNode: (form: NodeFormState) => Promise<void>;
  onUpdateNode: (id: number, form: NodeFormState) => Promise<void>;
  onDeleteNode: (id: number, name: string) => Promise<void>;
  onTestNode: (id: number) => Promise<NodeTestResult>;
  onSyncUsersToNode: (id: number, strategy: SyncConflictStrategy) => Promise<NodeSyncUsersResult>;
};

const STRATEGY_LABELS: Record<SyncConflictStrategy, string> = {
  overwrite: "Overwrite",
  skip: "Skip existing",
  "keep-both": "Keep both",
  safe: "Safe (check first)",
};

function emptyForm(): NodeFormState {
  return { name: "", url: "", secret: "", inboundId: "" };
}

export function NodesPanel({ nodes, onAddNode, onUpdateNode, onDeleteNode, onTestNode, onSyncUsersToNode }: NodesPanelProps) {
  const [form, setForm] = useState<NodeFormState>(emptyForm());
  const [editingNode, setEditingNode] = useState<NodeRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, NodeTestResult | null>>({});
  const [syncStrategy, setSyncStrategy] = useState<SyncConflictStrategy>("overwrite");
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [syncResults, setSyncResults] = useState<Record<number, NodeSyncUsersResult | null>>({});

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

  async function handleSyncUsers(id: number) {
    setSyncingId(id);
    try {
      const result = await onSyncUsersToNode(id, syncStrategy);
      setSyncResults((prev) => ({ ...prev, [id]: result }));
    } catch {
      setSyncResults((prev) => ({ ...prev, [id]: null }));
    } finally {
      setSyncingId(null);
    }
  }

  function startEdit(node: NodeRecord) {
    setEditingNode(node);
    setForm({ name: node.name, url: node.url, secret: "", inboundId: String(node.inboundId) });
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
                <Form.Label>Name</Form.Label>
                <Form.Control
                  required
                  placeholder="node-1"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Form.Group>
            </div>
            <div className="col-sm-6">
              <Form.Group controlId="node-inbound-id">
                <Form.Label>Inbound ID</Form.Label>
                <Form.Control
                  required
                  type="number"
                  min="1"
                  placeholder="1"
                  value={form.inboundId}
                  onChange={(e) => setForm({ ...form, inboundId: e.target.value })}
                />
              </Form.Group>
            </div>
          </div>

          <Form.Group className="mb-3" controlId="node-url">
            <Form.Label>URL</Form.Label>
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
              Shared secret{editingNode && <span className="text-muted fw-normal ms-1 small">(leave blank to keep current)</span>}
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
            <ListGroup variant="flush">
              {nodes.map((node) => {
                const testResult = testResults[node.id];
                const syncResult = syncResults[node.id];
                const isSyncing = syncingId === node.id;
                return (
                  <ListGroup.Item className="px-0 py-3" key={node.id}>
                    <div className="d-flex align-items-start gap-2">
                      <div className="flex-grow-1 min-w-0">
                        <div className="d-flex align-items-center gap-2 flex-wrap mb-1">
                          <span className="fw-semibold">{node.name}</span>
                          <Badge bg="secondary" className="font-monospace fw-normal">
                            inbound #{node.inboundId}
                          </Badge>
                          {testResult?.ok === true && (
                            <span className="text-success small d-flex align-items-center gap-1 flex-wrap">
                              <TbCircleCheck size={14} />
                              <span>OK</span>
                              {testResult.version && (
                                <Badge bg="success" className="fw-normal" style={{ fontSize: "0.7em" }}>
                                  v{testResult.version}
                                </Badge>
                              )}
                              {testResult.commit && (
                                <code className="text-success" style={{ fontSize: "0.75em" }}>{testResult.commit}</code>
                              )}
                              {testResult.date && (
                                <span className="text-body-secondary" style={{ fontSize: "0.75em" }}>{testResult.date}</span>
                              )}
                            </span>
                          )}
                          {testResult?.ok === false && (
                            <span className="text-danger small d-flex align-items-center gap-1">
                              <TbCircleX size={14} /> unreachable
                            </span>
                          )}
                        </div>
                        <div className="text-body-secondary small">
                          <code>{node.url}</code>
                        </div>
                        {syncResult !== undefined && syncResult !== null && (
                          <div className="mt-1 small">
                            {"conflicts" in syncResult ? (
                              <span className="text-danger d-flex align-items-center gap-1">
                                <TbCircleX size={13} />
                                Conflicts: {syncResult.conflicts.join(", ")}
                              </span>
                            ) : syncResult.failed > 0 ? (
                              <span className="text-warning d-flex align-items-center gap-1">
                                <TbCircleCheck size={13} />
                                {syncResult.synced} synced, {syncResult.failed} failed
                              </span>
                            ) : (
                              <span className="text-success d-flex align-items-center gap-1">
                                <TbCircleCheck size={13} />
                                {syncResult.synced} synced
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="d-flex gap-1 flex-shrink-0">
                        <Button
                          variant="outline-secondary"
                          size="sm"
                          onClick={() => handleTest(node.id)}
                          disabled={testingId === node.id}
                          title="Test connection"
                        >
                          {testingId === node.id ? <Spinner size="sm" /> : <TbWifi size={14} />}
                        </Button>
                        <SplitButton
                          title={isSyncing ? <Spinner size="sm" /> : <><TbCloudUpload size={14} className="me-1" />Sync users</>}
                          onClick={() => handleSyncUsers(node.id)}
                          variant="outline-secondary"
                          size="sm"
                          disabled={isSyncing}
                          id={`sync-users-${node.id}`}
                        >
                          {(Object.keys(STRATEGY_LABELS) as SyncConflictStrategy[]).map((s) => (
                            <Dropdown.Item key={s} active={syncStrategy === s} onClick={() => setSyncStrategy(s)}>
                              {STRATEGY_LABELS[s]}
                            </Dropdown.Item>
                          ))}
                        </SplitButton>
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
