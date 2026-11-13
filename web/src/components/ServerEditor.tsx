import { useEffect, useState } from "react";
import { Alert, Button, Col, Form, Modal, Row } from "react-bootstrap";
import { KINDS, labelOf, labelSlot, type Inventory, type ServerDraft } from "../inventory";
import type { NodeType } from "../types";
import { ProfileChips } from "./ProfileChips";
import { PlaceholderHelp, TemplateEditor } from "./TemplateEditor";

const TEMPLATE_HINTS: Record<NodeType, string> = {
  xui: "vless://{uuid}@{ip}:443?type=tcp&security=reality&…#🇩🇪 DE",
  naive: "naive+https://{user}:{pass}@example.com:443#🇩🇪 DE [Naïve]",
  shadowsocks: "ss://2022-blake3-aes-128-gcm:SERVER_PSK:{sskey}@{ip}:9444#🇩🇪 DE [SS]",
  mieru: "mierus://{user}:{mpass}@{ip}?profile=🇩🇪 DE&port=8444-8453&protocol=TCP#🇩🇪 DE",
};

/**
 * Create or edit one server: its link template, the agent backend its users are pushed
 * to (if any), and which profiles carry it.
 */
export function ServerEditor({
  draft,
  data,
  onSave,
  onClose,
}: {
  draft: ServerDraft | null;
  data: Inventory;
  onSave: (draft: ServerDraft) => Promise<unknown>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ServerDraft | null>(draft);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setForm(draft);
    setError("");
  }, [draft]);

  const members = draft?.id ? data.memberships.filter((m) => m.connectionId === draft.id) : [];
  const usedBy = members.map((m) => m.profile);
  const overridden = members.filter((m) => m.displayName !== null).map((m) => m.profile);
  const host = form?.target ? data.hosts.find((h) => h.id === form.target!.hostId) : undefined;
  const label = form ? labelOf(form.template) : null;
  const needsHost = !!form && !form.target && form.template.includes("{ip}");

  function setHost(value: string) {
    if (!form) return;
    if (!value) return setForm({ ...form, target: null });
    const hostId = Number(value);
    setForm({
      ...form,
      target: form.target
        ? { ...form.target, hostId }
        : { hostId, type: "naive", path: KINDS.naive.path, inboundId: 0 },
    });
  }
  function setType(type: NodeType) {
    if (!form?.target) return;
    const t = form.target;
    // Keep a custom path; replace one that was just the previous type's default.
    const path = !t.path || t.path === KINDS[t.type].path ? KINDS[type].path : t.path;
    setForm({ ...form, target: { ...t, type, path, inboundId: type === "xui" ? t.inboundId || 1 : 0 } });
  }

  async function submit() {
    if (!form) return;
    setSaving(true);
    setError("");
    try {
      await onSave({ ...form, name: form.name.trim(), template: form.template.trim() });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal show={form !== null} onHide={() => !saving && onClose()} size="lg" centered backdrop="static">
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">{form?.id ? `Edit ${draft?.name}` : "New server"}</Modal.Title>
        </Modal.Header>
        {form && (
          <Modal.Body>
            {error && <Alert variant="danger">{error}</Alert>}
            {usedBy.length > 1 && (
              <Alert variant="info" className="py-2 small">
                Shared by <strong>{usedBy.join(", ")}</strong>: changes here apply to all of them. To change only the
                label one profile shows, use that profile's page.
              </Alert>
            )}

            <Form.Group className="mb-3" controlId="server-name">
              <Form.Label className="fw-semibold">Name</Form.Label>
              <Form.Control
                required
                value={form.name}
                placeholder="e.g. vyrfop-naive"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Form.Text>
                Only shown in this panel. Clients see the label from the template: the text after #, or the profile=
                value for mieru.
              </Form.Text>
            </Form.Group>

            <fieldset className="border rounded p-3 mb-3">
              <legend className="float-none w-auto px-2 fs-6 fw-semibold mb-0">Sync users via agent</legend>
              <Form.Select
                aria-label="Host"
                value={form.target?.hostId ?? ""}
                onChange={(e) => setHost(e.target.value)}
              >
                <option value="">No agent: link only, users aren't pushed anywhere</option>
                {data.hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({h.url})
                  </option>
                ))}
              </Form.Select>
              {form.target && (
                <Row className="g-2 mt-1">
                  <Col sm={5}>
                    <Form.Label className="small mb-1" htmlFor="server-type">
                      Protocol
                    </Form.Label>
                    <Form.Select
                      id="server-type"
                      value={form.target.type}
                      onChange={(e) => setType(e.target.value as NodeType)}
                    >
                      {Object.entries(KINDS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label}
                        </option>
                      ))}
                    </Form.Select>
                  </Col>
                  <Col sm={form.target.type === "xui" ? 4 : 7}>
                    <Form.Label className="small mb-1" htmlFor="server-path">
                      Agent backend path
                    </Form.Label>
                    <Form.Control
                      id="server-path"
                      value={form.target.path}
                      placeholder="empty = default backend"
                      onChange={(e) => setForm({ ...form, target: { ...form.target!, path: e.target.value } })}
                    />
                  </Col>
                  {form.target.type === "xui" && (
                    <Col sm={3}>
                      <Form.Label className="small mb-1" htmlFor="server-inbound">
                        Inbound ID
                      </Form.Label>
                      <Form.Control
                        id="server-inbound"
                        type="number"
                        min={1}
                        required
                        value={form.target.inboundId}
                        onChange={(e) =>
                          setForm({ ...form, target: { ...form.target!, inboundId: Number(e.target.value) } })
                        }
                      />
                    </Col>
                  )}
                  <Col xs={12}>
                    <Form.Text>
                      Users of the selected profiles are pushed to{" "}
                      <code>
                        {host?.url}
                        {form.target.path}
                      </code>
                      {form.target.type === "xui" ? `, inbound ${form.target.inboundId}` : ""}. Servers on the same
                      backend share one user list.
                    </Form.Text>
                  </Col>
                </Row>
              )}
            </fieldset>

            <Form.Group className="mb-3">
              <Form.Label className="fw-semibold">
                Link template
                <PlaceholderHelp />
              </Form.Label>
              <TemplateEditor
                value={form.template}
                placeholder={TEMPLATE_HINTS[form.target?.type ?? "xui"]}
                onChange={(template) => setForm((f) => (f ? { ...f, template } : f))}
              />
              <Form.Text className={needsHost ? "text-danger" : undefined}>
                {needsHost
                  ? "{ip} takes the address from a host. Pick one above or write the address."
                  : label
                    ? `Clients see: ${label} (from ${labelSlot(form.template)})`
                    : "No #label: clients will show the address instead."}
                {!needsHost && overridden.length > 0 && ` (${overridden.join(", ")} show their own label)`}
              </Form.Text>
            </Form.Group>

            <Form.Group>
              <Form.Label className="fw-semibold d-block">In profiles</Form.Label>
              <ProfileChips
                label={form.name || "server"}
                profiles={data.profiles.map((p) => p.name)}
                isOn={(p) => form.profiles.includes(p)}
                onToggle={(p, on) =>
                  setForm({
                    ...form,
                    profiles: on ? [...form.profiles, p] : form.profiles.filter((x) => x !== p),
                  })
                }
              />
              <Form.Text>Existing users of these profiles are synced when you save.</Form.Text>
            </Form.Group>
          </Modal.Body>
        )}
        <Modal.Footer>
          <Button variant="outline-secondary" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || needsHost}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
