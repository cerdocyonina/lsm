import { useEffect, useState } from "react";
import { Alert, Button, Card, Col, Form, Modal, Row, Spinner } from "react-bootstrap";
import { api } from "../api";
import { KindBadge, type Host, type Inventory } from "../inventory";
import type { NodeType } from "../types";
import { ProfileChips } from "./ProfileChips";
import { PlaceholderHelp, TemplateEditor } from "./TemplateEditor";

export type HostForm = { id: number | null; name: string; url: string; secret: string };

/** Agent connection details. A new host is followed by backend discovery. */
export function HostEditor({
  host,
  onSave,
  onClose,
}: {
  host: HostForm | null;
  onSave: (host: HostForm) => Promise<unknown>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<HostForm | null>(host);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setForm(host);
    setError("");
  }, [host]);

  return (
    <Modal show={form !== null} onHide={() => !saving && onClose()} centered backdrop="static">
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (!form) return;
          setSaving(true);
          setError("");
          onSave({ ...form, name: form.name.trim(), url: form.url.trim() })
            .then(onClose)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setSaving(false));
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">{form?.id ? `Edit ${host?.name}` : "Add host"}</Modal.Title>
        </Modal.Header>
        {form && (
          <Modal.Body>
            {error && <Alert variant="danger">{error}</Alert>}
            <p className="text-body-secondary small">
              A host is one machine running <code>lsmnode</code>. All its servers (3x-ui inbounds, bare Xray VLESS,
              NaïveProxy, SS2022, mieru) are reached through this one agent.
            </p>
            <Form.Group className="mb-3" controlId="host-name">
              <Form.Label className="fw-semibold">Name</Form.Label>
              <Form.Control
                required
                value={form.name}
                placeholder="e.g. vyrfop"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-3" controlId="host-url">
              <Form.Label className="fw-semibold">Agent URL</Form.Label>
              <Form.Control
                required
                type="url"
                value={form.url}
                placeholder="http://1.2.3.4:9000"
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
              <Form.Text>
                Without a backend path. Templates can use <code>{"{ip}"}</code> to take the address from here.
              </Form.Text>
            </Form.Group>
            <Form.Group controlId="host-secret">
              <Form.Label className="fw-semibold">Agent secret</Form.Label>
              <Form.Control
                type="password"
                required={!form.id}
                value={form.secret}
                placeholder={form.id ? "Leave empty to keep the current one" : "SHARED_SECRET from lsmnode .env"}
                onChange={(e) => setForm({ ...form, secret: e.target.value })}
              />
            </Form.Group>
          </Modal.Body>
        )}
        <Modal.Footer>
          <Button variant="outline-secondary" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : form?.id ? "Save" : "Add and discover backends"}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

type Row = {
  include: boolean;
  name: string;
  type: NodeType;
  path: string;
  inboundId: number;
  template: string;
  profiles: string[];
  existing: string[];
};

/** Asks the agent which backends it runs and turns the chosen ones into servers. */
export function DiscoverModal({
  host,
  data,
  onCreate,
  onAddManually,
  onClose,
}: {
  host: Host | null;
  data: Inventory;
  onCreate: (host: Host, rows: Omit<Row, "include" | "existing">[]) => Promise<unknown>;
  onAddManually: (host: Host) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!host) return;
    setRows(null);
    setError("");
    api<{ backends: { name: string; kind: NodeType; path: string }[] }>("/inventory/discover", {
      method: "POST",
      body: JSON.stringify({ id: host.id, name: host.name, url: host.url, secret: "" }),
    })
      .then((r) =>
        setRows(
          r.backends.map((b) => {
            const services = data.services.filter(
              (s) => s.hostId === host.id && s.backendPath === b.path && s.type === b.kind,
            );
            const existing = data.connections
              .filter((c) => services.some((s) => s.id === c.nodeId))
              .map((c) => c.name);
            return {
              include: existing.length === 0,
              name: `${host.name}-${b.name}`,
              type: b.kind,
              path: b.path,
              inboundId: b.kind === "xui" ? 1 : 0,
              template: "",
              profiles: [],
              existing,
            };
          }),
        ),
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // Only re-run for a different host, not on every inventory refresh.
  }, [host?.id]);

  const chosen = rows?.filter((r) => r.include) ?? [];
  const update = (i: number, patch: Partial<Row>) =>
    setRows((old) => old && old.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  return (
    <Modal show={host !== null} onHide={() => !saving && onClose()} size="lg" centered backdrop="static">
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (!host || !chosen.length) return;
          setSaving(true);
          setError("");
          onCreate(
            host,
            chosen.map(({ include, existing, ...r }) => r),
          )
            .then(onClose)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setSaving(false));
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">Backends on {host?.name}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && (
            <Alert variant="warning">
              {error}
              {host && (
                <div className="mt-2">
                  <Button size="sm" variant="outline-dark" onClick={() => onAddManually(host)}>
                    Add a server manually
                  </Button>
                </div>
              )}
            </Alert>
          )}
          {!rows && !error && (
            <div className="text-center text-body-secondary py-4">
              <Spinner size="sm" className="me-2" />
              Asking the agent…
            </div>
          )}
          {rows && !rows.length && <p className="text-body-secondary">The agent reports no backends.</p>}
          {rows && rows.length > 0 && (
            <p className="text-body-secondary small">
              Pick the backends to turn into servers, paste each one's link template and choose profiles.
            </p>
          )}
          {rows?.map((r, i) => (
            <Card key={`${r.type}${r.path}`} className={`mb-3 ${r.include ? "" : "bg-body-tertiary"}`}>
              <Card.Body>
                <div className="d-flex align-items-center gap-2 flex-wrap">
                  <Form.Check
                    id={`discover-${i}`}
                    checked={r.include}
                    onChange={(e) => update(i, { include: e.target.checked })}
                    label={<KindBadge type={r.type} />}
                  />
                  <code className="small">{r.path || "default backend"}</code>
                  {r.existing.length > 0 && (
                    <span className="small text-body-secondary">already used by {r.existing.join(", ")}</span>
                  )}
                </div>
                {r.include && (
                  <>
                    <Row className="g-2 mt-1">
                      <Col sm={r.type === "xui" ? 9 : 12}>
                        <Form.Label className="small mb-1" htmlFor={`discover-name-${i}`}>
                          Server name
                        </Form.Label>
                        <Form.Control
                          id={`discover-name-${i}`}
                          required
                          value={r.name}
                          onChange={(e) => update(i, { name: e.target.value })}
                        />
                      </Col>
                      {r.type === "xui" && (
                        <Col sm={3}>
                          <Form.Label className="small mb-1" htmlFor={`discover-inbound-${i}`}>
                            Inbound ID
                          </Form.Label>
                          <Form.Control
                            id={`discover-inbound-${i}`}
                            type="number"
                            min={1}
                            required
                            value={r.inboundId}
                            onChange={(e) => update(i, { inboundId: Number(e.target.value) })}
                          />
                        </Col>
                      )}
                    </Row>
                    <Form.Label className="small mb-1 mt-2">
                      Link template
                      <PlaceholderHelp />
                    </Form.Label>
                    <TemplateEditor
                      minHeight="3.5rem"
                      value={r.template}
                      onChange={(template) => update(i, { template })}
                    />
                    <div className="d-flex align-items-center gap-2 mt-2">
                      <span className="small text-body-secondary">Profiles</span>
                      <ProfileChips
                        label={r.name}
                        profiles={data.profiles.map((p) => p.name)}
                        isOn={(p) => r.profiles.includes(p)}
                        onToggle={(p, on) =>
                          update(i, { profiles: on ? [...r.profiles, p] : r.profiles.filter((x) => x !== p) })
                        }
                      />
                    </div>
                  </>
                )}
              </Card.Body>
            </Card>
          ))}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" disabled={saving} onClick={onClose}>
            {rows?.length ? "Skip" : "Close"}
          </Button>
          {!!rows?.length && (
            <Button
              type="submit"
              disabled={saving || !chosen.length || chosen.some((r) => !r.template.trim())}
              title={chosen.some((r) => !r.template.trim()) ? "Every chosen backend needs a template" : undefined}
            >
              {saving ? "Creating…" : `Create ${chosen.length} server${chosen.length === 1 ? "" : "s"}`}
            </Button>
          )}
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
