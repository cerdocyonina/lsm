import { FormEvent } from "react";
import { Button, Card, Form, ListGroup, Stack } from "react-bootstrap";
import {
  ActionIconButton,
  CopyIcon,
  DeleteIcon,
  EditIcon,
} from "./ActionIconButton";
import type { UserFormState, UserRecord } from "../types";

type UsersPanelProps = {
  editingUser: UserRecord | null;
  onCancelEdit: () => void;
  onCopyLink: (value: string) => void;
  onDeleteUser: (clientName: string) => void;
  onEditUser: (user: UserRecord) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  savingUser: boolean;
  userForm: UserFormState;
  users: UserRecord[];
  setUserForm: (next: UserFormState) => void;
};

export function UsersPanel({
  editingUser,
  onCancelEdit,
  onCopyLink,
  onDeleteUser,
  onEditUser,
  onSubmit,
  savingUser,
  userForm,
  users,
  setUserForm,
}: UsersPanelProps) {
  return (
    <Card className="shadow-sm h-100">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-4">
          <div>
            <div className="text-uppercase text-muted small fw-semibold mb-1">
              Users
            </div>
            <h2 className="h5 mb-0">{editingUser ? "Edit user" : "Create user"}</h2>
          </div>
          {editingUser ? (
            <Button variant="outline-secondary" type="button" onClick={onCancelEdit}>
              Cancel edit
            </Button>
          ) : null}
        </div>

        <Form onSubmit={onSubmit}>
          <Form.Group className="mb-3" controlId="user-client-name">
            <Form.Label>Client name</Form.Label>
            <Form.Control
              required
              value={userForm.clientName}
              onChange={(event) =>
                setUserForm({
                  ...userForm,
                  clientName: event.target.value,
                })
              }
            />
          </Form.Group>

          <Form.Group className="mb-3" controlId="user-uuid">
            <Form.Label>User UUID</Form.Label>
            <Form.Control
              required
              value={userForm.userUuid}
              onChange={(event) =>
                setUserForm({
                  ...userForm,
                  userUuid: event.target.value,
                })
              }
            />
          </Form.Group>

          <Button type="submit" disabled={savingUser}>
            {savingUser
              ? "Saving..."
              : editingUser
                ? "Update user"
                : "Add user"}
          </Button>
        </Form>

        <hr className="my-4" />

        <ListGroup variant="flush">
          {users.map((user) => (
            <ListGroup.Item
              className="px-0 py-3"
              key={user.subscriptionToken}
            >
              <div className="admin-list-item">
                <div className="admin-list-copy">
                  <div className="fw-semibold">{user.clientName}</div>
                  <div className="text-body-secondary">
                    <code>{user.userUuid}</code>
                  </div>
                  <div className="admin-link-wrap">
                    <a href={user.subscriptionUrl} target="_blank" rel="noreferrer">
                      {user.subscriptionUrl}
                    </a>
                  </div>
                </div>
                <Stack className="admin-actions-column" gap={2}>
                  <ActionIconButton
                    icon={<CopyIcon />}
                    label="Copy subscription link"
                    onClick={() => onCopyLink(user.subscriptionUrl)}
                    variant="outline-secondary"
                  />
                  <ActionIconButton
                    icon={<EditIcon />}
                    label="Edit user"
                    onClick={() => onEditUser(user)}
                    variant="outline-primary"
                  />
                  <ActionIconButton
                    icon={<DeleteIcon />}
                    label="Delete user"
                    onClick={() => onDeleteUser(user.clientName)}
                    variant="outline-danger"
                  />
                </Stack>
              </div>
            </ListGroup.Item>
          ))}
        </ListGroup>
      </Card.Body>
    </Card>
  );
}
