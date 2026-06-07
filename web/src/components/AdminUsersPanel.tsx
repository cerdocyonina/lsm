import { FormEvent, useState } from "react";
import { Alert, Badge, Button, Card, Form, ListGroup, Spinner } from "react-bootstrap";
import { TbTrash } from "react-icons/tb";
import type { AdminUserRecord, Session } from "../types";
import { ActionIconButton } from "./ActionIconButton";

type AdminUsersPanelProps = {
  session: Session;
  adminUsers: AdminUserRecord[];
  onCreateAdminUser: (username: string, password: string) => Promise<void>;
  onDeleteAdminUser: (id: number, username: string) => Promise<void>;
};

function emptyForm() {
  return { username: "", password: "", confirmPassword: "" };
}

export function AdminUsersPanel({
  session,
  adminUsers,
  onCreateAdminUser,
  onDeleteAdminUser,
}: AdminUsersPanelProps) {
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreateAdminUser(form.username, form.password);
      setForm(emptyForm());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create admin user.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number, username: string) {
    setDeletingId(id);
    try {
      await onDeleteAdminUser(id, username);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete admin user.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card>
      <Card.Header>
        <strong>Panel Users</strong>
        <span className="text-muted ms-2" style={{ fontSize: "0.85em" }}>
          ({adminUsers.length})
        </span>
      </Card.Header>

      {adminUsers.length > 0 && (
        <ListGroup variant="flush">
          {adminUsers.map((u) => (
            <ListGroup.Item
              key={u.id}
              className="d-flex align-items-center justify-content-between"
            >
              <div>
                <strong>{u.username}</strong>
                {u.isPrimary && (
                  <Badge bg="primary" className="ms-2" style={{ fontSize: "0.75em" }}>
                    primary
                  </Badge>
                )}
                <div className="text-muted" style={{ fontSize: "0.8em" }}>
                  created {new Date(u.createdAt).toLocaleDateString()}
                </div>
              </div>
              <ActionIconButton
                icon={deletingId === u.id ? <Spinner size="sm" animation="border" /> : <TbTrash />}
                label="Delete"
                variant="outline-danger"
                disabled={u.isPrimary || u.username === session.username || deletingId !== null}
                onClick={() => handleDelete(u.id, u.username)}
              />
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}

      <Card.Body>
        {error && (
          <Alert variant="danger" dismissible onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Form onSubmit={handleSubmit}>
          <Form.Group className="mb-2">
            <Form.Label>Username</Form.Label>
            <Form.Control
              type="text"
              placeholder="lowercase letters, digits, hyphens"
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              pattern="[a-z0-9_-]+"
              required
            />
          </Form.Group>

          <Form.Group className="mb-2">
            <Form.Label>Password</Form.Label>
            <Form.Control
              type="password"
              placeholder="at least 8 characters"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              minLength={8}
              required
            />
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Confirm Password</Form.Label>
            <Form.Control
              type="password"
              placeholder="repeat password"
              value={form.confirmPassword}
              onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
              required
            />
          </Form.Group>

          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Creating…" : "Create Panel User"}
          </Button>
        </Form>
      </Card.Body>
    </Card>
  );
}
