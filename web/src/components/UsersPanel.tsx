import { FormEvent, useEffect, useRef, useState } from "react";
import { Button, Card, Form, InputGroup, ListGroup } from "react-bootstrap";
import {
  TbClipboard,
  TbQrcode,
  TbRefresh,
  TbTrash,
  TbUserEdit,
} from "react-icons/tb";
import type { UserFormState, UserRecord } from "../types";
import { ActionIconButton } from "./ActionIconButton";
import QRModal from "./QRModal";

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
  selectedUsers: Set<string>;
  onToggleUser: (clientName: string) => void;
  onToggleAllUsers: (visibleNames: string[]) => void;
  pingSelectionMode: boolean;
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
  selectedUsers,
  onToggleUser,
  onToggleAllUsers,
  pingSelectionMode,
}: UsersPanelProps) {
  const [qrModalShown, setQrModalShown] = useState(false);
  const [qrSelectedUser, setQrSelectedUser] = useState<UserRecord | null>(null);
  const [search, setSearch] = useState("");
  const selectAllRef = useRef<HTMLInputElement>(null);

  const UUID_PATTERN =
    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  const sortedUsers = [...users].sort((a, b) => b.createdAt - a.createdAt);
  const filteredUsers = search.trim()
    ? sortedUsers.filter(
        (u) =>
          u.clientName.toLowerCase().includes(search.toLowerCase()) ||
          u.userUuid.toLowerCase().includes(search.toLowerCase()),
      )
    : sortedUsers;

  const allFilteredSelected =
    filteredUsers.length > 0 && filteredUsers.every((u) => selectedUsers.has(u.clientName));
  const someFilteredSelected = filteredUsers.some((u) => selectedUsers.has(u.clientName));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [someFilteredSelected, allFilteredSelected]);

  const regenerateUserUuid = () => {
    setUserForm({
      ...userForm,
      userUuid: crypto.randomUUID(),
    });
  };

  return (
    <>
      <Card className="shadow-sm h-100">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-4">
            <div>
              <div className="text-uppercase text-muted small fw-semibold mb-1">
                Users
              </div>
              <h2 className="h5 mb-0">
                {editingUser ? "Edit user" : "Create user"}
              </h2>
            </div>
            {editingUser ? (
              <Button
                variant="outline-secondary"
                type="button"
                onClick={onCancelEdit}
              >
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
              <InputGroup>
                <Form.Control
                  required
                  pattern={UUID_PATTERN}
                  title="Must be a valid UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)"
                  value={userForm.userUuid}
                  onChange={(event) =>
                    setUserForm({
                      ...userForm,
                      userUuid: event.target.value,
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => regenerateUserUuid()}
                >
                  <TbRefresh />
                </Button>
              </InputGroup>
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

          <div className="d-flex align-items-center gap-2 mb-3">
            <Form.Group className="flex-grow-1 mb-0" controlId="user-search">
              <Form.Control
                type="search"
                placeholder="Search by name or UUID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </Form.Group>
            {pingSelectionMode && (
              <Form.Check
                ref={selectAllRef}
                type="checkbox"
                id="user-select-all"
                label="All"
                checked={allFilteredSelected}
                onChange={() => onToggleAllUsers(filteredUsers.map((u) => u.clientName))}
                disabled={filteredUsers.length === 0}
                title="Select / deselect all visible users for ping"
                className="mb-0 text-nowrap"
              />
            )}
          </div>

          <ListGroup variant="flush">
            {filteredUsers.map((user) => (
              <ListGroup.Item
                className="px-0 py-3"
                key={user.subscriptionToken}
              >
                <div
                  className="admin-list-item"
                  style={
                    pingSelectionMode
                      ? { gridTemplateColumns: "auto minmax(0,1fr) auto" }
                      : undefined
                  }
                >
                  {pingSelectionMode && (
                    <Form.Check
                      type="checkbox"
                      id={`user-sel-${user.clientName}`}
                      aria-label={`Select ${user.clientName}`}
                      checked={selectedUsers.has(user.clientName)}
                      onChange={() => onToggleUser(user.clientName)}
                      className="d-flex align-items-center mb-0"
                      title="Select / deselect user for ping"
                    />
                  )}
                  <div className="admin-list-copy">
                    <div className="fw-semibold">{user.clientName}</div>
                    <div className="text-body-secondary">
                      <code>{user.userUuid}</code>
                    </div>
                    <div className="admin-link-wrap">
                      <a
                        href={user.subscriptionUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {user.subscriptionUrl}
                      </a>
                    </div>
                    <div className="admin-meta">
                      <small className="text-muted">
                        {new Date(user.createdAt).toLocaleString("ru-RU", {
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
                      icon={<TbClipboard />}
                      label="Copy subscription link"
                      onClick={() => onCopyLink(user.subscriptionUrl)}
                      variant="outline-secondary"
                    />
                    <ActionIconButton
                      size="sm"
                      icon={<TbUserEdit />}
                      label="Edit user"
                      onClick={() => onEditUser(user)}
                      variant="outline-primary"
                    />
                    <ActionIconButton
                      size="sm"
                      icon={<TbTrash />}
                      label="Delete user"
                      onClick={() => onDeleteUser(user.clientName)}
                      variant="outline-danger"
                    />
                    <ActionIconButton
                      size="sm"
                      icon={<TbQrcode />}
                      label="Generate QR code"
                      onClick={() => {
                        setQrSelectedUser(user);
                        setQrModalShown(true);
                      }}
                      variant="outline-secondary"
                    />
                  </div>
                </div>
              </ListGroup.Item>
            ))}
          </ListGroup>
        </Card.Body>
      </Card>
      <QRModal
        show={qrModalShown}
        setShow={setQrModalShown}
        user={qrSelectedUser}
      />
    </>
  );
}
