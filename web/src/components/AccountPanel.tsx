import { FormEvent, useState } from "react";
import { Alert, Button, Card, Col, Form, Row } from "react-bootstrap";
import toast from "react-hot-toast";
import { updateAccount } from "../api";
import type { Session } from "../types";

type AccountPanelProps = {
  session: Session;
  onUsernameChanged: (newUsername: string) => void;
};

export function AccountPanel({ session, onUsernameChanged }: AccountPanelProps) {
  const [usernameValue, setUsernameValue] = useState(session.username);
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function handleUsernameSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = usernameValue.trim();
    if (!trimmed) return;
    setSavingUsername(true);
    setUsernameError(null);
    try {
      await updateAccount({ username: trimmed });
      onUsernameChanged(trimmed);
    } catch (err) {
      setUsernameError(err instanceof Error ? err.message : "Failed to update username.");
    } finally {
      setSavingUsername(false);
    }
  }

  async function handlePasswordSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }
    setSavingPassword(true);
    setPasswordError(null);
    try {
      await updateAccount({ currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword });
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      toast.success("Password updated");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to update password.");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <Row className="g-4">
      <Col md={6}>
        <Card>
          <Card.Header><strong>Change Username</strong></Card.Header>
          <Card.Body>
            {usernameError && (
              <Alert variant="danger" dismissible onClose={() => setUsernameError(null)}>
                {usernameError}
              </Alert>
            )}
            <Form onSubmit={handleUsernameSubmit}>
              <Form.Group className="mb-3">
                <Form.Label>New username</Form.Label>
                <Form.Control
                  type="text"
                  placeholder="lowercase letters, digits, hyphens"
                  value={usernameValue}
                  onChange={(e) => setUsernameValue(e.target.value)}
                  pattern="[a-z0-9_-]+"
                  required
                />
                <Form.Text className="text-body-secondary">
                  Lowercase alphanumeric, hyphens, underscores.
                </Form.Text>
              </Form.Group>
              <Button type="submit" variant="primary" disabled={savingUsername || usernameValue.trim() === session.username}>
                {savingUsername ? "Saving…" : "Save Username"}
              </Button>
            </Form>
          </Card.Body>
        </Card>
      </Col>

      <Col md={6}>
        <Card>
          <Card.Header><strong>Change Password</strong></Card.Header>
          <Card.Body>
            {passwordError && (
              <Alert variant="danger" dismissible onClose={() => setPasswordError(null)}>
                {passwordError}
              </Alert>
            )}
            <Form onSubmit={handlePasswordSubmit}>
              <Form.Group className="mb-2">
                <Form.Label>Current password</Form.Label>
                <Form.Control
                  type="password"
                  value={passwordForm.currentPassword}
                  onChange={(e) => setPasswordForm((f) => ({ ...f, currentPassword: e.target.value }))}
                  required
                />
              </Form.Group>
              <Form.Group className="mb-2">
                <Form.Label>New password</Form.Label>
                <Form.Control
                  type="password"
                  placeholder="at least 8 characters"
                  value={passwordForm.newPassword}
                  onChange={(e) => setPasswordForm((f) => ({ ...f, newPassword: e.target.value }))}
                  minLength={8}
                  required
                />
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label>Confirm new password</Form.Label>
                <Form.Control
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={(e) => setPasswordForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                  required
                />
              </Form.Group>
              <Button type="submit" variant="primary" disabled={savingPassword}>
                {savingPassword ? "Saving…" : "Save Password"}
              </Button>
            </Form>
          </Card.Body>
        </Card>
      </Col>
    </Row>
  );
}
