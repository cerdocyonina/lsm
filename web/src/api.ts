const adminBasePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const apiBasePath = import.meta.env.DEV ? "/api" : `${adminBasePath}/api`;

export function profilePath(profileId: string, subPath: string): string {
  return `/profiles/${encodeURIComponent(profileId)}${subPath}`;
}

export async function fetchAdminUsers() {
  return api<{ adminUsers: import("./types").AdminUserRecord[] }>("/admin-users");
}

export async function createAdminUser(username: string, password: string) {
  return api<{ adminUsers: import("./types").AdminUserRecord[] }>("/admin-users", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function deleteAdminUser(id: number) {
  return api<void>(`/admin-users/${id}`, { method: "DELETE" });
}

export async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const normalizedPath = input.startsWith("/") ? input : `/${input}`;
  const response = await fetch(`${apiBasePath}${normalizedPath}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error
        : "Request failed.";
    throw new Error(message);
  }

  return payload as T;
}
