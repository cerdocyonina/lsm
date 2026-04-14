import { FormEvent, useEffect, useState } from "react";
import { Alert, Button, Col, Container, Navbar, Row, Spinner } from "react-bootstrap";
import toast from "react-hot-toast";
import { api } from "./api";
import { LoginPage } from "./components/LoginPage";
import { ServersPanel } from "./components/ServersPanel";
import { UsersPanel } from "./components/UsersPanel";
import type {
  ServerFormState,
  ServerRecord,
  Session,
  UserFormState,
  UserRecord,
} from "./types";

function emptyUserForm(): UserFormState {
  return { clientName: "", userUuid: "" };
}

function emptyServerForm(): ServerFormState {
  return { name: "", template: "" };
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loginPending, setLoginPending] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [userForm, setUserForm] = useState<UserFormState>(emptyUserForm);
  const [serverForm, setServerForm] = useState<ServerFormState>(emptyServerForm);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [editingServer, setEditingServer] = useState<ServerRecord | null>(null);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });

  async function loadDashboard() {
    const [userPayload, serverPayload] = await Promise.all([
      api<{ users: UserRecord[] }>("/users"),
      api<{ servers: ServerRecord[] }>("/servers"),
    ]);

    setUsers(userPayload.users);
    setServers(serverPayload.servers);
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const currentSession = await api<Session>("/session");
        if (cancelled) {
          return;
        }

        setSession(currentSession);
        await loadDashboard();
      } catch {
        if (!cancelled) {
          setSession(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshAfterMutation() {
    try {
      await loadDashboard();
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
      await loadDashboard();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setLoginPending(false);
    }
  }

  async function handleLogout() {
    await api("/auth/logout", { method: "POST" });
    setSession(null);
    setUsers([]);
    setServers([]);
    setEditingUser(null);
    setEditingServer(null);
    setDashboardError(null);
  }

  async function submitUserForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingUser(true);
    setDashboardError(null);
    const wasEditing = editingUser !== null;

    try {
      if (editingUser) {
        await api(`/users/${encodeURIComponent(editingUser.clientName)}`, {
          method: "PATCH",
          body: JSON.stringify(userForm),
        });
      } else {
        await api("/users", {
          method: "POST",
          body: JSON.stringify(userForm),
        });
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
        await api(`/servers/${encodeURIComponent(editingServer.name)}`, {
          method: "PATCH",
          body: JSON.stringify(serverForm),
        });
      } else {
        await api("/servers", {
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

  async function deleteUser(clientName: string) {
    if (!window.confirm(`Remove user "${clientName}"?`)) {
      return;
    }

    try {
      await api(`/users/${encodeURIComponent(clientName)}`, {
        method: "DELETE",
      });
      await refreshAfterMutation();
      toast.success("User deleted");
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to delete user.",
      );
    }
  }

  async function reorderServers(names: string[]) {
    // Optimistic update: reorder local state immediately
    const nameToRecord = new Map(servers.map((s) => [s.name, s]));
    setServers(names.map((name, i) => ({ ...nameToRecord.get(name)!, sortOrder: i })));

    try {
      await api("/servers/order", {
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
      await api(`/servers/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await refreshAfterMutation();
      toast.success("Server deleted");
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to delete server.",
      );
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
          <Navbar.Brand className="fw-semibold">LSM Admin</Navbar.Brand>
          <div className="d-flex align-items-center gap-3 ms-auto">
            <span className="text-body-secondary small">
              Signed in as <strong>{session.username}</strong>
            </span>
            <Button variant="outline-secondary" type="button" onClick={handleLogout}>
              Logout
            </Button>
          </div>
        </Container>
      </Navbar>

      <Container fluid="lg" className="py-4">
        <div className="mb-4">
          <h1 className="h3 mb-1">Admin panel</h1>
          <p className="text-body-secondary mb-0">
            Manage subscription users and server templates.
          </p>
        </div>

        {dashboardError ? (
          <Alert variant="danger" className="mb-4">
            {dashboardError}
          </Alert>
        ) : null}

        <Row className="g-4">
          <Col xl={6}>
            <UsersPanel
              editingUser={editingUser}
              onCancelEdit={() => {
                setEditingUser(null);
                setUserForm(emptyUserForm());
              }}
              onCopyLink={copyText}
              onDeleteUser={deleteUser}
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
            />
          </Col>
          <Col xl={6}>
            <ServersPanel
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
                });
              }}
              onReorder={reorderServers}
              onSubmit={submitServerForm}
              savingServer={savingServer}
              serverForm={serverForm}
              servers={servers}
              setServerForm={setServerForm}
            />
          </Col>
        </Row>
      </Container>
    </>
  );
}
