import {
  FormEvent,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Alert,
  Badge,
  Button,
  Col,
  Container,
  Form,
  Modal,
  Nav,
  Navbar,
  Row,
  Spinner,
} from "react-bootstrap";
import toast from "react-hot-toast";
import { TbDownload, TbPencil, TbTrash, TbUpload } from "react-icons/tb";
import {
  api,
  createAdminUser,
  deleteAdminUser,
  exportAll,
  exportProfile,
  fetchAdminUsers,
  importAll,
  importProfile,
  profilePath,
} from "./api";
import { AccountPanel } from "./components/AccountPanel";
import { AdminUsersPanel } from "./components/AdminUsersPanel";
import { LoginPage } from "./components/LoginPage";
import { ProfileServersPanel } from "./components/ProfileServersPanel";
import { ProfileTabs } from "./components/ProfileTabs";
import { ServersPage } from "./components/ServersPage";
import { SyncReportModal } from "./components/SyncReportModal";
import { UsersPanel } from "./components/UsersPanel";
import { useInventory } from "./inventory";
import type {
  AdminUserRecord,
  ClientHttpPingResult,
  NodeRecord,
  PingResponse,
  ProfileRecord,
  ServerIcmpResult,
  ServerRecord,
  Session,
  SyncResult,
  UserFormState,
  UserRecord,
} from "./types";

function emptyUserForm(): UserFormState {
  return { clientName: "", userUuid: crypto.randomUUID() };
}

/**
 * Brings a ping selection in line with a freshly loaded list. Names that disappeared are
 * dropped. New names are selected only if everything previously known was selected, so
 * "all" stays "all" after adding an item, while a hand-picked subset (or an empty
 * selection) is left alone. On the first load for a profile everything is selected.
 */
function reconcileSelection(
  prev: Set<string>,
  known: Set<string>,
  names: string[],
): Set<string> {
  if (known.size === 0) return new Set(names);
  const allKnownSelected = [...known].every((n) => prev.has(n));
  const next = new Set<string>();
  for (const name of names) {
    if (prev.has(name) || (allKnownSelected && !known.has(name)))
      next.add(name);
  }
  return next;
}

/** Keeps a renamed item's selection state instead of treating it as removed + new. */
function carrySelectionOverRename(
  known: { current: Set<string> },
  setSelected: Dispatch<SetStateAction<Set<string>>>,
  oldName: string,
  newName: string,
) {
  if (oldName === newName) return;
  const nextKnown = new Set(known.current);
  nextKnown.delete(oldName);
  nextKnown.add(newName);
  known.current = nextKnown;
  setSelected((prev) => {
    if (!prev.has(oldName)) return prev;
    const next = new Set(prev);
    next.delete(oldName);
    next.add(newName);
    return next;
  });
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>("main");
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUserRecord[]>([]);
  const [loginPending, setLoginPending] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const [userForm, setUserForm] = useState<UserFormState>(emptyUserForm);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [icmpResults, setIcmpResults] = useState<ServerIcmpResult[]>([]);
  const [httpResults, setHttpResults] = useState<ClientHttpPingResult[]>([]);
  const [pinging, setPinging] = useState(false);
  const [selectedServers, setSelectedServers] = useState<Set<string>>(
    new Set(),
  );
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [pingSelectionMode, setPingSelectionMode] = useState(false);
  // Names seen on the previous dashboard load — lets reconcileSelection tell new items
  // apart from ones the admin deliberately left unselected.
  const knownUserNames = useRef<Set<string>>(new Set());
  const knownServerNames = useRef<Set<string>>(new Set());

  const [showDeleteUserModal, setShowDeleteUserModal] = useState(false);
  const [deletingUserName, setDeletingUserName] = useState<string | null>(null);
  const [deleteNodeIds, setDeleteNodeIds] = useState<Set<number>>(new Set());
  const [deletingUser, setDeletingUser] = useState(false);
  const [showRenameProfile, setShowRenameProfile] = useState(false);
  const [renameProfileName, setRenameProfileName] = useState("");
  const [showDeleteProfile, setShowDeleteProfile] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [activePage, setActivePage] = useState<
    "main" | "nodes" | "admin-users" | "account"
  >("main");

  // Shared server catalog; mutations refresh the profile view (users, ping lists) too.
  const inventory = useInventory(session !== null, async () => {
    await loadNodes();
    await refreshAfterMutation();
  });
  useEffect(() => {
    if (session) void inventory.reload().catch(() => {});
  }, [profiles]);

  async function loadProfiles(): Promise<ProfileRecord[]> {
    const payload = await api<{ profiles: ProfileRecord[] }>("/profiles");
    setProfiles(payload.profiles);
    return payload.profiles;
  }

  async function loadNodes() {
    const payload = await api<{ nodes: NodeRecord[] }>("/nodes");
    setNodes(payload.nodes);
  }

  async function loadAdminUsers() {
    const payload = await fetchAdminUsers();
    setAdminUsers(payload.adminUsers);
  }

  async function loadDashboard(profileId: string) {
    const [userPayload, serverPayload] = await Promise.all([
      api<{ users: UserRecord[] }>(profilePath(profileId, "/users")),
      api<{ servers: ServerRecord[] }>(profilePath(profileId, "/servers")),
    ]);

    setUsers(userPayload.users);
    setServers(serverPayload.servers);

    const userNames = userPayload.users.map((u) => u.clientName);
    const prevKnownUsers = knownUserNames.current;
    knownUserNames.current = new Set(userNames);
    setSelectedUsers((prev) =>
      reconcileSelection(prev, prevKnownUsers, userNames),
    );

    const serverNames = serverPayload.servers.map((s) => s.name);
    const prevKnownServers = knownServerNames.current;
    knownServerNames.current = new Set(serverNames);
    setSelectedServers((prev) =>
      reconcileSelection(prev, prevKnownServers, serverNames),
    );
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const currentSession = await api<Session>("/session");
        if (cancelled) return;

        setSession(currentSession);
        const loaders: Promise<unknown>[] = [loadProfiles(), loadNodes()];
        if (currentSession.isPrimary) loaders.push(loadAdminUsers());
        const [loadedProfiles] = (await Promise.all(loaders)) as [
          ProfileRecord[],
          ...unknown[],
        ];
        const initialProfile = loadedProfiles[0]?.name ?? "main";
        setActiveProfileId(initialProfile);
        await loadDashboard(initialProfile);
      } catch {
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reload dashboard when active profile changes (after initial load)
  const [profileSwitchCount, setProfileSwitchCount] = useState(0);
  useEffect(() => {
    if (profileSwitchCount === 0) return;
    setUsers([]);
    setServers([]);
    setIcmpResults([]);
    setHttpResults([]);
    setEditingUser(null);
    setUserForm(emptyUserForm());
    setSelectedUsers(new Set());
    setSelectedServers(new Set());
    knownUserNames.current = new Set();
    knownServerNames.current = new Set();
    setDashboardError(null);
    void loadDashboard(activeProfileId).catch((error) => {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to load dashboard.",
      );
    });
  }, [activeProfileId, profileSwitchCount]);

  function switchProfile(id: string) {
    setActiveProfileId(id);
    setProfileSwitchCount((c) => c + 1);
  }

  async function refreshAfterMutation() {
    try {
      await loadDashboard(activeProfileId);
      setDashboardError(null);
    } catch (error) {
      if (error instanceof Error && error.message === "Unauthorized.") {
        setSession(null);
      }
      setDashboardError(
        error instanceof Error ? error.message : "Failed to refresh dashboard.",
      );
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginPending(true);
    setAuthError(null);

    try {
      const currentSession = await api<Session>("/auth/login", {
        method: "POST",
        body: JSON.stringify(loginForm),
      });
      setSession(currentSession);
      const loaders2: Promise<unknown>[] = [loadProfiles(), loadNodes()];
      if (currentSession.isPrimary) loaders2.push(loadAdminUsers());
      const [loadedProfiles2] = (await Promise.all(loaders2)) as [
        ProfileRecord[],
        ...unknown[],
      ];
      const initialProfile = loadedProfiles2[0]?.name ?? "main";
      setActiveProfileId(initialProfile);
      await loadDashboard(initialProfile);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setLoginPending(false);
    }
  }

  async function handleLogout() {
    await api("/auth/logout", { method: "POST" });
    setSession(null);
    setProfiles([]);
    setUsers([]);
    setServers([]);
    setAdminUsers([]);
    setEditingUser(null);
    setDashboardError(null);
  }

  async function handleCreateAdminUser(username: string, password: string) {
    const payload = await createAdminUser(username, password);
    setAdminUsers(payload.adminUsers);
    toast.success(`Panel user "${username}" created`);
  }

  function handleUsernameChanged(newUsername: string) {
    setSession((prev) => (prev ? { ...prev, username: newUsername } : prev));
    toast.success("Username updated");
  }

  async function handleDeleteAdminUser(id: number, username: string) {
    if (!window.confirm(`Delete panel user "${username}" and all their data?`))
      return;
    await deleteAdminUser(id);
    setAdminUsers((prev) => prev.filter((u) => u.id !== id));
    toast.success(`Panel user "${username}" deleted`);
  }

  function downloadJson(data: unknown, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleExportProfile() {
    try {
      const data = await exportProfile(activeProfileId);
      downloadJson(data, `${activeProfileId}.json`);
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Export failed.",
      );
    }
  }

  async function handleExportAll() {
    try {
      const data = await exportAll();
      downloadJson(data, "lsm-export.json");
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Export failed.",
      );
    }
  }

  async function handleImport(file: File) {
    setImporting(true);
    setImportError(null);
    try {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        setImportError("Invalid JSON file.");
        return;
      }

      const isMultiProfile =
        data !== null &&
        typeof data === "object" &&
        "profiles" in (data as Record<string, unknown>) &&
        !Array.isArray((data as Record<string, unknown>).profiles);

      if (isMultiProfile) {
        await importAll(data);
        await Promise.all([loadProfiles(), refreshAfterMutation()]);
        toast.success("All profiles imported");
      } else {
        await importProfile(activeProfileId, data);
        await refreshAfterMutation();
        toast.success("Import successful");
      }
      setShowImportModal(false);
      setImportFile(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  async function handleCreateProfile(name: string) {
    try {
      const payload = await api<{ profiles: ProfileRecord[] }>("/profiles", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setProfiles(payload.profiles);
      toast.success(`Profile "${name}" created`);
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to create profile.",
      );
    }
  }

  async function handleRenameProfile(name: string, newName: string) {
    try {
      const payload = await api<{ profiles: ProfileRecord[] }>(
        `/profiles/${encodeURIComponent(name)}`,
        { method: "PATCH", body: JSON.stringify({ name: newName }) },
      );
      setProfiles(payload.profiles);
      if (activeProfileId === name) setActiveProfileId(newName);
      toast.success("Profile renamed");
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to rename profile.",
      );
    }
  }

  async function handleDeleteProfile(name: string) {
    try {
      await api(`/profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
      const remaining = profiles.filter((p) => p.name !== name);
      setProfiles(remaining);
      toast.success("Profile deleted");
      if (activeProfileId === name && remaining.length > 0) {
        switchProfile(remaining[0]!.name);
      }
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to delete profile.",
      );
    }
  }

  async function submitUserForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingUser(true);
    setDashboardError(null);
    const wasEditing = editingUser !== null;

    try {
      if (editingUser) {
        await api(
          profilePath(
            activeProfileId,
            `/users/${encodeURIComponent(editingUser.clientName)}`,
          ),
          {
            method: "PATCH",
            body: JSON.stringify(userForm),
          },
        );
        carrySelectionOverRename(
          knownUserNames,
          setSelectedUsers,
          editingUser.clientName,
          userForm.clientName,
        );
      } else {
        const payload = await api<{
          users: UserRecord[];
          syncResults?: SyncResult[];
        }>(profilePath(activeProfileId, "/users"), {
          method: "POST",
          body: JSON.stringify(userForm),
        });
        if (payload.syncResults && payload.syncResults.length > 0) {
          const failures = payload.syncResults.filter(
            (r) => r.result === "failed",
          );
          if (failures.length > 0) {
            toast.error(
              `User added, but sync failed on: ${failures.map((f) => f.nodeName ?? f.nodeId).join(", ")}`,
            );
          } else {
            toast.success(
              `User added & synced to ${payload.syncResults.length} node(s)`,
            );
          }
          setUserForm(emptyUserForm());
          setEditingUser(null);
          await refreshAfterMutation();
          setSavingUser(false);
          return;
        }
      }

      setUserForm(emptyUserForm());
      setEditingUser(null);
      await refreshAfterMutation();
      toast.success(wasEditing ? "User saved" : "User added");
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to save user.",
      );
    } finally {
      setSavingUser(false);
    }
  }

  async function performDeleteUser(clientName: string, nodeIds: number[]) {
    setDeletingUser(true);
    try {
      const url = profilePath(
        activeProfileId,
        `/users/${encodeURIComponent(clientName)}`,
      );
      if (nodeIds.length > 0) {
        const payload = await api<{ syncResults: SyncResult[] }>(url, {
          method: "DELETE",
          body: JSON.stringify({ nodeIds }),
        });
        const failures = payload.syncResults.filter(
          (r) => r.result === "failed",
        );
        if (failures.length > 0) {
          toast.error(
            `User deleted, but removal failed on: ${failures.map((f) => f.nodeName ?? f.nodeId).join(", ")}`,
          );
        } else {
          toast.success(
            `User deleted and removed from ${payload.syncResults.length} node(s)`,
          );
        }
      } else {
        await api(url, { method: "DELETE" });
        toast.success("User deleted");
      }
      await refreshAfterMutation();
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to delete user.",
      );
    } finally {
      setDeletingUser(false);
      setShowDeleteUserModal(false);
      setDeletingUserName(null);
    }
  }

  async function deleteUser(clientName: string) {
    const profileNodeIds = new Set(
      servers.filter((s) => s.nodeId !== null).map((s) => s.nodeId!),
    );
    const relevantNodes = nodes.filter((n) => profileNodeIds.has(n.id));

    if (relevantNodes.length === 0) {
      if (!window.confirm(`Remove user "${clientName}"?`)) return;
      await performDeleteUser(clientName, []);
    } else {
      setDeletingUserName(clientName);
      setDeleteNodeIds(new Set(relevantNodes.map((n) => n.id)));
      setShowDeleteUserModal(true);
    }
  }

  async function handleResyncUser(clientName: string): Promise<SyncResult[]> {
    try {
      const payload = await api<{ syncResults: SyncResult[] }>(
        profilePath(
          activeProfileId,
          `/users/${encodeURIComponent(clientName)}/sync`,
        ),
        { method: "POST" },
      );
      const failures = payload.syncResults.filter((r) => r.result === "failed");
      if (failures.length > 0) {
        toast.error(
          `Sync failed on: ${failures.map((f) => f.nodeName ?? f.nodeId).join(", ")}`,
        );
      } else if (payload.syncResults.length === 0) {
        toast("No nodes configured", { icon: "ℹ️" });
      } else {
        toast.success(
          `"${clientName}" resynced to ${payload.syncResults.length} node(s)`,
        );
      }
      return payload.syncResults;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Resync failed.");
      return [];
    }
  }

  function toggleServer(name: string) {
    setSelectedServers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleUser(clientName: string) {
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(clientName)) next.delete(clientName);
      else next.add(clientName);
      return next;
    });
  }

  async function pingAllServers() {
    // The API treats an empty `servers`/`users` list as "no filter", so an empty
    // selection must never be sent as-is — it would silently ping everything.
    if (pingSelectionMode && selectedServers.size === 0) {
      toast.error("Select at least one server to ping.");
      return;
    }
    const icmpOnly = pingSelectionMode && selectedUsers.size === 0;

    setPinging(true);
    try {
      const body: Record<string, unknown> = {};
      if (pingSelectionMode) {
        if (selectedServers.size < servers.length)
          body.servers = [...selectedServers];
        if (icmpOnly) body.strategy = "icmp";
        else if (selectedUsers.size < users.length)
          body.users = [...selectedUsers];
      }
      const serverCount = pingSelectionMode
        ? selectedServers.size
        : servers.length;
      const userCount = pingSelectionMode ? selectedUsers.size : users.length;
      const payload = await toast.promise(
        api<PingResponse>(profilePath(activeProfileId, "/servers/ping"), {
          method: "POST",
          body: JSON.stringify(body),
        }),
        {
          loading: icmpOnly
            ? `Pinging ${serverCount} server(s), ICMP only (no users selected)…`
            : `Pinging ${serverCount} server(s) × ${userCount} user(s)…`,
          success: "Ping complete",
          error: "Ping failed.",
        },
      );
      if (payload.icmp) setIcmpResults(payload.icmp);
      if (payload.http) setHttpResults(payload.http);
      else if (icmpOnly) setHttpResults([]);
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Ping failed.",
      );
    } finally {
      setPinging(false);
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Link copied");
    } catch {
      setDashboardError("Clipboard access failed.");
    }
  }

  if (loading) {
    return (
      <Container className="py-5 min-vh-100 d-flex align-items-center justify-content-center">
        <div className="text-center text-secondary">
          <Spinner className="mb-3" />
          <div>Loading admin panel...</div>
        </div>
      </Container>
    );
  }

  if (!session) {
    return (
      <LoginPage
        authError={authError}
        loginForm={loginForm}
        loginPending={loginPending}
        onSubmit={handleLogin}
        onChange={setLoginForm}
      />
    );
  }

  return (
    <>
      <Navbar bg="white" expand="lg" className="border-bottom shadow-sm">
        <Container>
          <Navbar.Brand className="fw-semibold">
            LSM Admin
            <Badge
              bg="secondary"
              className="fw-normal ms-2"
              style={{ fontSize: "0.65em", verticalAlign: "middle" }}
            >
              v{__APP_VERSION__}
            </Badge>
          </Navbar.Brand>
          <Nav className="me-auto ms-3">
            <Nav.Link
              active={activePage === "main"}
              onClick={() => setActivePage("main")}
            >
              Profiles
            </Nav.Link>
            <Nav.Link
              active={activePage === "nodes"}
              onClick={() => setActivePage("nodes")}
            >
              Servers
            </Nav.Link>
            {session.isPrimary && (
              <Nav.Link
                active={activePage === "admin-users"}
                onClick={() => setActivePage("admin-users")}
              >
                Panel Users
              </Nav.Link>
            )}
            {!session.isPrimary && (
              <Nav.Link
                active={activePage === "account"}
                onClick={() => setActivePage("account")}
              >
                My Account
              </Nav.Link>
            )}
          </Nav>
          <div className="d-flex align-items-center gap-3">
            <span className="text-body-secondary small">
              Signed in as <strong>{session.username}</strong>
            </span>
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={handleExportAll}
            >
              <TbDownload size={13} className="me-1" />
              Export all
            </Button>
            <Button
              variant="outline-secondary"
              type="button"
              onClick={handleLogout}
            >
              Logout
            </Button>
          </div>
        </Container>
      </Navbar>

      {activePage === "main" && (
        <ProfileTabs
          profiles={profiles}
          activeProfileName={activeProfileId}
          onSelect={switchProfile}
          onCreateProfile={handleCreateProfile}
        />
      )}

      {activePage === "main" && (
        <Container fluid="lg" className="pt-3 pb-1">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <span className="text-body-secondary small me-1">
              Profile: <strong>{activeProfileId}</strong>
            </span>
            <div className="d-flex gap-1">
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={() => {
                  setRenameProfileName(activeProfileId);
                  setShowRenameProfile(true);
                }}
              >
                <TbPencil size={13} className="me-1" />
                Rename
              </Button>
              <Button
                variant="outline-danger"
                size="sm"
                onClick={() => setShowDeleteProfile(true)}
              >
                <TbTrash size={13} className="me-1" />
                Delete
              </Button>
            </div>
            <div className="d-flex gap-1 ms-2 border-start ps-2">
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={handleExportProfile}
              >
                <TbDownload size={13} className="me-1" />
                Export
              </Button>
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={() => {
                  setImportFile(null);
                  setImportError(null);
                  setShowImportModal(true);
                }}
              >
                <TbUpload size={13} className="me-1" />
                Import
              </Button>
            </div>
          </div>
        </Container>
      )}

      <Container fluid="lg" className="py-4">
        {dashboardError ? (
          <Alert variant="danger" className="mb-4">
            {dashboardError}
          </Alert>
        ) : null}

        {activePage === "account" && !session.isPrimary ? (
          <AccountPanel
            session={session}
            onUsernameChanged={handleUsernameChanged}
          />
        ) : activePage === "admin-users" && session.isPrimary ? (
          <AdminUsersPanel
            session={session}
            adminUsers={adminUsers}
            onCreateAdminUser={handleCreateAdminUser}
            onDeleteAdminUser={handleDeleteAdminUser}
          />
        ) : activePage === "nodes" ? (
          <ServersPage inv={inventory} />
        ) : (
          <Row className="g-4 mb-4">
            <Col xl={5}>
              <UsersPanel
                editingUser={editingUser}
                onCancelEdit={() => {
                  setEditingUser(null);
                  setUserForm(emptyUserForm());
                }}
                onCopyLink={copyText}
                onDeleteUser={deleteUser}
                onResyncUser={handleResyncUser}
                onEditUser={(user) => {
                  setEditingUser(user);
                  setUserForm({
                    clientName: user.clientName,
                    userUuid: user.userUuid,
                  });
                }}
                onSubmit={submitUserForm}
                savingUser={savingUser}
                userForm={userForm}
                users={users}
                setUserForm={setUserForm}
                selectedUsers={selectedUsers}
                onToggleUser={toggleUser}
                onSelectUsers={setSelectedUsers}
                pingSelectionMode={pingSelectionMode}
              />
            </Col>
            <Col xl={7}>
              <ProfileServersPanel
                profile={activeProfileId}
                inv={inventory}
                icmp={icmpResults}
                http={httpResults}
                pinging={pinging}
                selectionMode={pingSelectionMode}
                selected={selectedServers}
                onToggleSelectionMode={() => setPingSelectionMode((v) => !v)}
                onToggleServer={toggleServer}
                onSelectServers={setSelectedServers}
                onPing={pingAllServers}
              />
            </Col>
          </Row>
        )}
      </Container>

      <SyncReportModal inv={inventory} />

      {/* Rename profile modal */}
      <Modal
        show={showRenameProfile}
        onHide={() => setShowRenameProfile(false)}
        centered
        size="sm"
      >
        <Form
          onSubmit={async (e) => {
            e.preventDefault();
            const newName = renameProfileName.trim();
            if (!newName) return;
            setShowRenameProfile(false);
            await handleRenameProfile(activeProfileId, newName);
          }}
        >
          <Modal.Header closeButton>
            <Modal.Title className="h6">Rename profile</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Group>
              <Form.Label className="small fw-semibold">New name</Form.Label>
              <Form.Control
                size="sm"
                value={renameProfileName}
                onChange={(e) => setRenameProfileName(e.target.value)}
                pattern="^[a-z0-9_-]+$"
                title="Lowercase letters, digits, hyphens, underscores"
                autoFocus
                required
              />
              <Form.Text className="text-body-secondary">
                Lowercase alphanumeric, hyphens, underscores.
              </Form.Text>
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowRenameProfile(false)}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit">
              Save
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Delete user modal (shown when profile has nodes) */}
      <Modal
        show={showDeleteUserModal}
        onHide={() => setShowDeleteUserModal(false)}
        centered
        size="sm"
      >
        <Modal.Header closeButton>
          <Modal.Title className="h6">
            Delete &ldquo;{deletingUserName}&rdquo;
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="mb-1">Also remove from these agents:</p>
          {nodes
            .filter((n) => servers.some((s) => s.nodeId === n.id))
            .map((n) => (
              <Form.Check
                key={n.id}
                type="checkbox"
                id={`del-node-${n.id}`}
                label={servers
                  .filter((s) => s.nodeId === n.id)
                  .map((s) => s.name)
                  .join(", ")}
                checked={deleteNodeIds.has(n.id)}
                onChange={() =>
                  setDeleteNodeIds((prev) => {
                    const next = new Set(prev);
                    next.has(n.id) ? next.delete(n.id) : next.add(n.id);
                    return next;
                  })
                }
              />
            ))}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outline-secondary"
            size="sm"
            disabled={deletingUser}
            onClick={() => setShowDeleteUserModal(false)}
          >
            Cancel
          </Button>
          <Button
            variant="outline-danger"
            size="sm"
            disabled={deletingUser}
            onClick={() => {
              if (deletingUserName)
                void performDeleteUser(deletingUserName, []);
            }}
          >
            LSM only
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={deletingUser || deleteNodeIds.size === 0}
            onClick={() => {
              if (deletingUserName)
                void performDeleteUser(deletingUserName, [...deleteNodeIds]);
            }}
          >
            {deletingUser ? "Deleting…" : "LSM + agents"}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Import modal */}
      <Modal
        show={showImportModal}
        onHide={() => setShowImportModal(false)}
        centered
        size="sm"
      >
        <Modal.Header closeButton>
          <Modal.Title className="h6">
            Import into &ldquo;{activeProfileId}&rdquo;
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {importError && (
            <Alert
              variant="danger"
              dismissible
              onClose={() => setImportError(null)}
            >
              {importError}
            </Alert>
          )}
          <Form.Group>
            <Form.Label className="small fw-semibold">JSON file</Form.Label>
            <Form.Control
              type="file"
              accept=".json,application/json"
              size="sm"
              onChange={(e) =>
                setImportFile((e.target as HTMLInputElement).files?.[0] ?? null)
              }
            />
            <Form.Text className="text-body-secondary">
              Single-profile exports and legacy configs are merged into the
              current profile. Multi-profile dumps restore all profiles.
            </Form.Text>
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowImportModal(false)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!importFile || importing}
            onClick={() => {
              if (importFile) void handleImport(importFile);
            }}
          >
            {importing ? "Importing…" : "Import"}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete profile modal */}
      <Modal
        show={showDeleteProfile}
        onHide={() => setShowDeleteProfile(false)}
        centered
        size="sm"
      >
        <Modal.Header closeButton>
          <Modal.Title className="h6">Delete profile</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="mb-0">
            Delete <strong>{activeProfileId}</strong>? All users and servers in
            this profile will be permanently removed.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowDeleteProfile(false)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              setShowDeleteProfile(false);
              await handleDeleteProfile(activeProfileId);
            }}
          >
            Delete
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
