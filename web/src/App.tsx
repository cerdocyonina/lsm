import { FormEvent, useEffect, useState } from "react";
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
import { api, createAdminUser, deleteAdminUser, exportAll, exportProfile, fetchAdminUsers, importAll, importProfile, profilePath } from "./api";
import { AccountPanel } from "./components/AccountPanel";
import { AdminUsersPanel } from "./components/AdminUsersPanel";
import { LoginPage } from "./components/LoginPage";
import { NodesPanel } from "./components/NodesPanel";
import { ProfileTabs } from "./components/ProfileTabs";
import { ServersPanel } from "./components/ServersPanel";
import { UsersPanel } from "./components/UsersPanel";
import type {
  AdminUserRecord,
  ClientHttpPingResult,
  NodeFormState,
  NodeRecord,
  NodeTestResult,
  PingResponse,
  ProfileRecord,
  ServerFormState,
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

function emptyServerForm(): ServerFormState {
  return { name: "", template: "", nodeId: null };
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
  const [savingServer, setSavingServer] = useState(false);
  const [userForm, setUserForm] = useState<UserFormState>(emptyUserForm);
  const [serverForm, setServerForm] =
    useState<ServerFormState>(emptyServerForm);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [editingServer, setEditingServer] = useState<ServerRecord | null>(null);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [icmpResults, setIcmpResults] = useState<ServerIcmpResult[]>([]);
  const [httpResults, setHttpResults] = useState<ClientHttpPingResult[]>([]);
  const [pinging, setPinging] = useState(false);
  const [selectedServers, setSelectedServers] = useState<Set<string>>(
    new Set(),
  );
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [pingSelectionMode, setPingSelectionMode] = useState(false);

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
  const [activePage, setActivePage] = useState<"main" | "nodes" | "admin-users" | "account">("main");

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
    setSelectedUsers((prev) => {
      if (prev.size === 0)
        return new Set(userPayload.users.map((u) => u.clientName));
      const updated = new Set<string>();
      for (const u of userPayload.users) {
        if (prev.has(u.clientName)) updated.add(u.clientName);
      }
      return updated;
    });
    setSelectedServers((prev) => {
      if (prev.size === 0)
        return new Set(serverPayload.servers.map((s) => s.name));
      const updated = new Set<string>();
      for (const s of serverPayload.servers) {
        if (prev.has(s.name)) updated.add(s.name);
      }
      return updated;
    });
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
        const [loadedProfiles] = await Promise.all(loaders) as [ProfileRecord[], ...unknown[]];
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
    setEditingServer(null);
    setUserForm(emptyUserForm());
    setServerForm(emptyServerForm());
    setSelectedUsers(new Set());
    setSelectedServers(new Set());
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
      const [loadedProfiles2] = await Promise.all(loaders2) as [ProfileRecord[], ...unknown[]];
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
    setEditingServer(null);
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
    if (!window.confirm(`Delete panel user "${username}" and all their data?`)) return;
    await deleteAdminUser(id);
    setAdminUsers((prev) => prev.filter((u) => u.id !== id));
    toast.success(`Panel user "${username}" deleted`);
  }

  function downloadJson(data: unknown, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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
      setDashboardError(error instanceof Error ? error.message : "Export failed.");
    }
  }

  async function handleExportAll() {
    try {
      const data = await exportAll();
      downloadJson(data, "lsm-export.json");
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "Export failed.");
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
      } else {
        const payload = await api<{ users: UserRecord[]; syncResults?: SyncResult[] }>(
          profilePath(activeProfileId, "/users"),
          { method: "POST", body: JSON.stringify(userForm) },
        );
        if (payload.syncResults && payload.syncResults.length > 0) {
          const failures = payload.syncResults.filter((r) => r.result === "failed");
          if (failures.length > 0) {
            toast.error(`User added, but sync failed on: ${failures.map((f) => f.nodeName ?? f.nodeId).join(", ")}`);
          } else {
            toast.success(`User added & synced to ${payload.syncResults.length} node(s)`);
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

  async function submitServerForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingServer(true);
    setDashboardError(null);
    const wasEditing = editingServer !== null;

    try {
      if (editingServer) {
        await api(
          profilePath(
            activeProfileId,
            `/servers/${encodeURIComponent(editingServer.name)}`,
          ),
          {
            method: "PATCH",
            body: JSON.stringify(serverForm),
          },
        );
      } else {
        await api(profilePath(activeProfileId, "/servers"), {
          method: "POST",
          body: JSON.stringify(serverForm),
        });
      }

      setServerForm(emptyServerForm());
      setEditingServer(null);
      await refreshAfterMutation();
      toast.success(wasEditing ? "Server saved" : "Server added");
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to save server.",
      );
    } finally {
      setSavingServer(false);
    }
  }

  async function performDeleteUser(clientName: string, nodeIds: number[]) {
    setDeletingUser(true);
    try {
      const url = profilePath(activeProfileId, `/users/${encodeURIComponent(clientName)}`);
      if (nodeIds.length > 0) {
        const payload = await api<{ syncResults: SyncResult[] }>(url, {
          method: "DELETE",
          body: JSON.stringify({ nodeIds }),
        });
        const failures = payload.syncResults.filter((r) => r.result === "failed");
        if (failures.length > 0) {
          toast.error(
            `User deleted, but removal failed on: ${failures.map((f) => f.nodeName ?? f.nodeId).join(", ")}`,
          );
        } else {
          toast.success(`User deleted and removed from ${payload.syncResults.length} node(s)`);
        }
      } else {
        await api(url, { method: "DELETE" });
        toast.success("User deleted");
      }
      await refreshAfterMutation();
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "Failed to delete user.");
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
        profilePath(activeProfileId, `/users/${encodeURIComponent(clientName)}/sync`),
        { method: "POST" },
      );
      const failures = payload.syncResults.filter((r) => r.result === "failed");
      if (failures.length > 0) {
        toast.error(`Sync failed on: ${failures.map((f) => f.nodeName ?? f.nodeId).join(", ")}`);
      } else if (payload.syncResults.length === 0) {
        toast("No nodes configured", { icon: "ℹ️" });
      } else {
        toast.success(`"${clientName}" resynced to ${payload.syncResults.length} node(s)`);
      }
      return payload.syncResults;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Resync failed.");
      return [];
    }
  }

  async function handleAddNode(form: NodeFormState) {
    await api<{ nodes: NodeRecord[] }>("/nodes", {
      method: "POST",
      body: JSON.stringify({
        name: form.name,
        url: form.url,
        secret: form.secret,
        inboundId: parseInt(form.inboundId, 10),
      }),
    });
    await loadNodes();
    toast.success(`Node "${form.name}" added`);
  }

  async function handleUpdateNode(id: number, form: NodeFormState) {
    const body: Record<string, unknown> = {
      name: form.name,
      url: form.url,
      inboundId: parseInt(form.inboundId, 10),
    };
    if (form.secret) body.secret = form.secret;
    await api<{ nodes: NodeRecord[] }>(`/nodes/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    await loadNodes();
    toast.success("Node updated");
  }

  async function handleDeleteNode(id: number, name: string) {
    if (!window.confirm(`Remove node "${name}"?`)) return;
    await api(`/nodes/${id}`, { method: "DELETE" });
    await loadNodes();
    toast.success("Node deleted");
  }

  async function handleTestNode(id: number): Promise<NodeTestResult> {
    return api<NodeTestResult>(`/nodes/${id}/test`, { method: "POST" });
  }

  async function reorderServers(names: string[]) {
    const nameToRecord = new Map(servers.map((s) => [s.name, s]));
    setServers(
      names.map((name, i) => ({ ...nameToRecord.get(name)!, sortOrder: i })),
    );

    try {
      await api(profilePath(activeProfileId, "/servers/order"), {
        method: "PUT",
        body: JSON.stringify({ order: names }),
      });
      await refreshAfterMutation();
    } catch (error) {
      await refreshAfterMutation();
      setDashboardError(
        error instanceof Error ? error.message : "Failed to reorder servers.",
      );
    }
  }

  async function deleteServer(name: string) {
    if (!window.confirm(`Remove server "${name}"?`)) {
      return;
    }

    try {
      await api(
        profilePath(activeProfileId, `/servers/${encodeURIComponent(name)}`),
        {
          method: "DELETE",
        },
      );
      await refreshAfterMutation();
      toast.success("Server deleted");
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to delete server.",
      );
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

  function toggleAllServers(visibleNames: string[]) {
    const allSelected = visibleNames.every((n) => selectedServers.has(n));
    setSelectedServers((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleNames.forEach((n) => next.delete(n));
      else visibleNames.forEach((n) => next.add(n));
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

  function toggleAllUsers(visibleNames: string[]) {
    const allSelected = visibleNames.every((n) => selectedUsers.has(n));
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleNames.forEach((n) => next.delete(n));
      else visibleNames.forEach((n) => next.add(n));
      return next;
    });
  }

  async function pingAllServers() {
    setPinging(true);
    try {
      const body: Record<string, unknown> = {};
      if (pingSelectionMode) {
        if (selectedServers.size < servers.length)
          body.servers = [...selectedServers];
        if (selectedUsers.size < users.length) body.users = [...selectedUsers];
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
          loading: `Pinging ${serverCount} server(s) × ${userCount} user(s)…`,
          success: "Ping complete",
          error: "Ping failed.",
        },
      );
      if (payload.icmp) setIcmpResults(payload.icmp);
      if (payload.http) setHttpResults(payload.http);
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
            <Badge bg="secondary" className="fw-normal ms-2" style={{ fontSize: "0.65em", verticalAlign: "middle" }}>
              v{__APP_VERSION__}
            </Badge>
          </Navbar.Brand>
          <Nav className="me-auto ms-3">
            <Nav.Link active={activePage === "main"} onClick={() => setActivePage("main")}>
              Users &amp; Servers
            </Nav.Link>
            <Nav.Link active={activePage === "nodes"} onClick={() => setActivePage("nodes")}>
              Nodes
            </Nav.Link>
            {session.isPrimary && (
              <Nav.Link active={activePage === "admin-users"} onClick={() => setActivePage("admin-users")}>
                Panel Users
              </Nav.Link>
            )}
            {!session.isPrimary && (
              <Nav.Link active={activePage === "account"} onClick={() => setActivePage("account")}>
                My Account
              </Nav.Link>
            )}
          </Nav>
          <div className="d-flex align-items-center gap-3">
            <span className="text-body-secondary small">
              Signed in as <strong>{session.username}</strong>
            </span>
            <Button variant="outline-secondary" size="sm" onClick={handleExportAll}>
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
            <Button variant="outline-secondary" size="sm" onClick={handleExportProfile}>
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
          <AccountPanel session={session} onUsernameChanged={handleUsernameChanged} />
        ) : activePage === "admin-users" && session.isPrimary ? (
          <AdminUsersPanel
            session={session}
            adminUsers={adminUsers}
            onCreateAdminUser={handleCreateAdminUser}
            onDeleteAdminUser={handleDeleteAdminUser}
          />
        ) : activePage === "nodes" ? (
          <NodesPanel
            nodes={nodes}
            onAddNode={handleAddNode}
            onUpdateNode={handleUpdateNode}
            onDeleteNode={handleDeleteNode}
            onTestNode={handleTestNode}
          />
        ) : (
        <Row className="g-4 mb-4">
          <Col xl={6}>
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
              onToggleAllUsers={toggleAllUsers}
              pingSelectionMode={pingSelectionMode}
            />
          </Col>
          <Col xl={6}>
            <ServersPanel
              nodes={nodes}
              editingServer={editingServer}
              onCancelEdit={() => {
                setEditingServer(null);
                setServerForm(emptyServerForm());
              }}
              onDeleteServer={deleteServer}
              onEditServer={(server) => {
                setEditingServer(server);
                setServerForm({
                  name: server.name,
                  template: server.template,
                  nodeId: server.nodeId,
                });
              }}
              httpResults={httpResults}
              icmpResults={icmpResults}
              onPingAll={pingAllServers}
              onReorder={reorderServers}
              onSubmit={submitServerForm}
              pinging={pinging}
              savingServer={savingServer}
              serverForm={serverForm}
              servers={servers}
              setServerForm={setServerForm}
              selectedServers={selectedServers}
              onToggleServer={toggleServer}
              onToggleAllServers={toggleAllServers}
              pingSelectionMode={pingSelectionMode}
              onTogglePingSelection={() => setPingSelectionMode((v) => !v)}
            />
          </Col>
        </Row>
        )}
      </Container>

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
          <Modal.Title className="h6">Delete &ldquo;{deletingUserName}&rdquo;</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="mb-1">Also remove from nodes:</p>
          {nodes
            .filter((n) => servers.some((s) => s.nodeId === n.id))
            .map((n) => (
              <Form.Check
                key={n.id}
                type="checkbox"
                id={`del-node-${n.id}`}
                label={n.name}
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
              if (deletingUserName) void performDeleteUser(deletingUserName, []);
            }}
          >
            LSM only
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={deletingUser || deleteNodeIds.size === 0}
            onClick={() => {
              if (deletingUserName) void performDeleteUser(deletingUserName, [...deleteNodeIds]);
            }}
          >
            {deletingUser ? "Deleting…" : "LSM + nodes"}
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
          <Modal.Title className="h6">Import into &ldquo;{activeProfileId}&rdquo;</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {importError && (
            <Alert variant="danger" dismissible onClose={() => setImportError(null)}>
              {importError}
            </Alert>
          )}
          <Form.Group>
            <Form.Label className="small fw-semibold">JSON file</Form.Label>
            <Form.Control
              type="file"
              accept=".json,application/json"
              size="sm"
              onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
            />
            <Form.Text className="text-body-secondary">
              Single-profile exports and legacy configs are merged into the current profile.
              Multi-profile dumps restore all profiles.
            </Form.Text>
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="sm" onClick={() => setShowImportModal(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!importFile || importing}
            onClick={() => { if (importFile) void handleImport(importFile); }}
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
