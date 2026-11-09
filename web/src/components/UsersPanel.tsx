import { FormEvent, useEffect, useState } from "react";
import { Button, Card, Form, InputGroup, ListGroup } from "react-bootstrap";
import { Paginator } from "./Paginator";
import { SelectionBar } from "./SelectionBar";
import {
  TbClipboard,
  TbQrcode,
  TbRefresh,
  TbReload,
  TbTrash,
  TbUserEdit,
} from "react-icons/tb";
import type { SyncResult, UserFormState, UserRecord } from "../types";
import { ActionIconButton } from "./ActionIconButton";
import QRModal from "./QRModal";

type UserSort =
  | "created-desc"
  | "created-asc"
  | "name-asc"
  | "name-desc"
  | "fetched-desc"
  | "fetched-asc";

const USER_SORT_OPTIONS: { value: UserSort; label: string }[] = [
  { value: "created-desc", label: "Newest first" },
  { value: "created-asc", label: "Oldest first" },
  { value: "name-asc", label: "Name A → Z" },
  { value: "name-desc", label: "Name Z → A" },
  { value: "fetched-desc", label: "Recently fetched" },
  { value: "fetched-asc", label: "Not fetched longest" },
];

const SORT_STORAGE_KEY = "lsm.users.sort";

function loadUserSort(): UserSort {
  try {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    if (USER_SORT_OPTIONS.some((o) => o.value === saved)) return saved as UserSort;
  } catch {
    // storage unavailable (private mode etc.) — fall back to the default
  }
  return "created-desc";
}

function saveUserSort(sort: UserSort) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort);
  } catch {
    // non-essential convenience
  }
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareUsers(a: UserRecord, b: UserRecord, sort: UserSort): number {
  switch (sort) {
    case "created-asc":
      return a.createdAt - b.createdAt;
    case "name-asc":
      return nameCollator.compare(a.clientName, b.clientName);
    case "name-desc":
      return nameCollator.compare(b.clientName, a.clientName);
    case "fetched-desc":
      // never-fetched users go last
      return (b.lastFetchedAt ?? -1) - (a.lastFetchedAt ?? -1) || b.createdAt - a.createdAt;
    case "fetched-asc":
      // never-fetched users go first: they're the likeliest to be unused
      return (a.lastFetchedAt ?? -1) - (b.lastFetchedAt ?? -1) || b.createdAt - a.createdAt;
    case "created-desc":
    default:
      return b.createdAt - a.createdAt;
  }
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatAgo(ts: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days} d ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

/** Current time, re-rendering every minute so "N min ago" labels don't go stale. */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

type UsersPanelProps = {
  editingUser: UserRecord | null;
  onCancelEdit: () => void;
  onCopyLink: (value: string) => void;
  onDeleteUser: (clientName: string) => void;
  onEditUser: (user: UserRecord) => void;
  onResyncUser: (clientName: string) => Promise<SyncResult[]>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  savingUser: boolean;
  userForm: UserFormState;
  users: UserRecord[];
  setUserForm: (next: UserFormState) => void;
  selectedUsers: Set<string>;
  onToggleUser: (clientName: string) => void;
  onSelectUsers: (next: Set<string>) => void;
  pingSelectionMode: boolean;
};

export function UsersPanel({
  editingUser,
  onCancelEdit,
  onCopyLink,
  onDeleteUser,
  onEditUser,
  onResyncUser,
  onSubmit,
  savingUser,
  userForm,
  users,
  setUserForm,
  selectedUsers,
  onToggleUser,
  onSelectUsers,
  pingSelectionMode,
}: UsersPanelProps) {
  const [qrModalShown, setQrModalShown] = useState(false);
  const [qrSelectedUser, setQrSelectedUser] = useState<UserRecord | null>(null);
  const [search, setSearch] = useState("");
  const [syncingUser, setSyncingUser] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<UserSort>(loadUserSort);
  const now = useNow();

  const UUID_PATTERN =
    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  const query = search.trim().toLowerCase();
  const sortedUsers = [...users].sort((a, b) => compareUsers(a, b, sort));
  const filteredUsers = query
    ? sortedUsers.filter(
        (u) =>
          u.clientName.toLowerCase().includes(query) ||
          u.userUuid.toLowerCase().includes(query),
      )
    : sortedUsers;

  // Reset to page 1 when search, sort or page size changes
  useEffect(() => { setPage(1); }, [search, sort, pageSize]);

  const paginatedUsers =
    pageSize === 0
      ? filteredUsers
      : filteredUsers.slice((page - 1) * pageSize, page * pageSize);

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

          <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
            <Form.Group className="flex-grow-1 mb-0" controlId="user-search">
              <Form.Control
                type="search"
                placeholder="Search by name or UUID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </Form.Group>
            <Form.Select
              aria-label="Sort users"
              title="Sort users"
              className="w-auto"
              value={sort}
              onChange={(e) => {
                const next = e.target.value as UserSort;
                setSort(next);
                saveUserSort(next);
              }}
            >
              {USER_SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Form.Select>
          </div>

          {pingSelectionMode && (
            <SelectionBar
              id="user-select-all"
              noun="users"
              allNames={users.map((u) => u.clientName)}
              matchingNames={filteredUsers.map((u) => u.clientName)}
              filterActive={query.length > 0}
              selected={selectedUsers}
              onChange={onSelectUsers}
            />
          )}

          <ListGroup variant="flush">
            {paginatedUsers.map((user) => (
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
                    <div className="admin-meta d-flex flex-wrap column-gap-2">
                      <small className="text-muted" title="Created">
                        {formatDateTime(user.createdAt)}
                      </small>
                      {user.lastFetchedAt !== null ? (
                        <small
                          className="text-muted"
                          title={`Subscription last fetched ${formatDateTime(user.lastFetchedAt)}`}
                        >
                          · fetched {formatAgo(user.lastFetchedAt, now)}
                        </small>
                      ) : (
                        <small
                          className="text-body-tertiary fst-italic"
                          title="Subscription has not been fetched since tracking was added"
                        >
                          · never fetched
                        </small>
                      )}
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
                    <ActionIconButton
                      size="sm"
                      icon={syncingUser === user.clientName ? <TbReload className="spin" /> : <TbReload />}
                      label="Force resync to nodes"
                      disabled={syncingUser === user.clientName}
                      onClick={async () => {
                        setSyncingUser(user.clientName);
                        await onResyncUser(user.clientName);
                        setSyncingUser(null);
                      }}
                      variant="outline-secondary"
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
            totalCount={filteredUsers.length}
          />
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
