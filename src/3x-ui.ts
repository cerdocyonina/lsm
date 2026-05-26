import { logger } from "./logger";

export interface XUIConfig {
  host: string;
  user: string;
  password: string;
}

export class XUIService {
  private baseUrl: string;
  private cookie: string | null = null;
  private csrfToken: string | null = null;

  constructor(private config: XUIConfig) {
    this.baseUrl = config.host.replace(/\/+$/, "");
  }

  private async request(path: string, options: BunFetchRequestInit = {}) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;

    const method = ((options.method as string) ?? "GET").toUpperCase();
    const isStateChanging = !["GET", "HEAD", "OPTIONS", "TRACE"].includes(method);

    const headers: Record<string, string> = {
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
      // Attach stored CSRF token to every state-changing request automatically.
      // The login call overrides this via options.headers when it has a
      // fresh pre-login token that differs from the stored one.
      ...(isStateChanging && this.csrfToken
        ? { "X-CSRF-Token": this.csrfToken }
        : {}),
      ...((options.headers as Record<string, string>) || {}),
    };

    const response = await fetch(url, {
      ...options,
      tls: { rejectUnauthorized: false },
      headers,
    });

    if (!response.ok) {
      throw new Error(
        `Request to ${path} failed with status: ${response.status}`,
      );
    }

    return response;
  }

  /**
   * Fetches (or creates) the CSRF token for the current session via the
   * dedicated /csrf-token endpoint.  Also captures the Set-Cookie header so
   * the session cookie is stored for the next request.
   */
  private async fetchCsrfToken(): Promise<string> {
    const response = await this.request("/csrf-token");

    // The endpoint calls EnsureCSRFToken which may create a new session —
    // grab the session cookie so the subsequent login POST shares it.
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      this.cookie = setCookie.split(";")[0]!;
    }

    const data = (await response.json()) as any;
    if (!data.success || typeof data.obj !== "string") {
      throw new Error("Failed to obtain CSRF token from 3x-ui");
    }
    return data.obj;
  }

  async login(): Promise<void> {
    // Step 1 — get a pre-login session + matching CSRF token.
    const preCsrf = await this.fetchCsrfToken();

    const params = new URLSearchParams();
    params.append("username", this.config.user);
    params.append("password", this.config.password);

    logger.debug(params);

    // Step 2 — POST credentials; override the auto-CSRF with the pre-login token.
    const response = await this.request("/login", {
      method: "POST",
      body: params,
      headers: { "X-CSRF-Token": preCsrf },
    });

    const result = (await response.json()) as any;
    if (!result.success) {
      throw new Error(
        `Login failed: ${result.msg ?? "unknown error (check logs)"}`,
      );
    }

    // Step 3 — capture the new authenticated session cookie.
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) {
      throw new Error("No cookie received from 3x-ui");
    }
    this.cookie = setCookie.split(";")[0]!;

    // Step 4 — refresh CSRF token for the authenticated session.
    // The pre-login token is bound to the anonymous session and is no longer
    // valid now that the session cookie changed.
    this.csrfToken = await this.fetchCsrfToken();

    console.log("Successfully logged in to 3x-ui");
  }

  // ---------------------------------------------------------------------------
  // Client helpers (new /panel/api/clients/* API)
  // ---------------------------------------------------------------------------

  private async clientExists(email: string): Promise<boolean> {
    try {
      const response = await this.request(
        `/panel/api/clients/get/${encodeURIComponent(email)}`,
      );
      const data = (await response.json()) as any;
      return data.success && data.obj != null;
    } catch {
      return false;
    }
  }

  private async getAllClientEmails(): Promise<Set<string>> {
    const response = await this.request("/panel/api/clients/list");
    const data = (await response.json()) as any;
    if (!data.success || !Array.isArray(data.obj)) return new Set();
    return new Set(data.obj.map((c: any) => c.email as string));
  }

  // ---------------------------------------------------------------------------
  // syncUser
  // ---------------------------------------------------------------------------

  async syncUser(
    inboundId: number,
    email: string,
    uuid: string,
    onConflict: "skip" | "overwrite" | "keep-both" = "skip",
  ): Promise<"added" | "overwritten" | "skipped" | "kept-both" | "failed"> {
    if (!this.cookie) await this.login();

    const exists = await this.clientExists(email);

    if (exists) {
      if (onConflict === "skip") {
        logger.warn(`User "${email}" already exists. Skipping...`);
        return "skipped";
      }

      if (onConflict === "overwrite") {
        return await this.updateUser(inboundId, email, uuid);
      }

      // keep-both: find an available suffixed name
      const existingEmails = await this.getAllClientEmails();
      let suffix = 1;
      let candidate = `${email}_${suffix}`;
      while (existingEmails.has(candidate)) {
        suffix++;
        candidate = `${email}_${suffix}`;
      }
      const result = await this.addNewUser(inboundId, candidate, uuid);
      if (result === "added") {
        logger.info(
          `User "${email}" already exists — added as "${candidate}".`,
        );
        return "kept-both";
      }
      return "failed";
    }

    return await this.addNewUser(inboundId, email, uuid);
  }

  private async addNewUser(
    inboundId: number,
    email: string,
    uuid: string,
  ): Promise<"added" | "failed"> {
    const response = await this.request("/panel/api/clients/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: {
          id: uuid,
          flow: "xtls-rprx-vision",
          email,
          limitIp: 0,
          totalGB: 0,
          expiryTime: 0,
          enable: true,
          tgId: 0, // int64 in the new model, not a string
          subId: "",
        },
        inboundIds: [inboundId],
      }),
    });

    const result = (await response.json()) as any;
    if (result.success) {
      logger.info(`User "${email}" added successfully.`);
      return "added";
    }
    logger.error(`Failed to add "${email}": ${result.msg}`);
    return "failed";
  }

  private async updateUser(
    inboundId: number,
    email: string,
    newUuid: string,
  ): Promise<"overwritten" | "failed"> {
    // New API: keyed on email in the URL, flat model.Client body.
    // inboundId is unused here — the server looks up existing inbound
    // attachments and keeps them; pass it only for future-proofing if needed.
    void inboundId;

    const response = await this.request(
      `/panel/api/clients/update/${encodeURIComponent(email)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newUuid,
          flow: "xtls-rprx-vision",
          email,
          limitIp: 0,
          totalGB: 0,
          expiryTime: 0,
          enable: true,
          tgId: 0,
          subId: "",
        }),
      },
    );

    const result = (await response.json()) as any;
    if (result.success) {
      logger.info(`User "${email}" overwritten successfully.`);
      return "overwritten";
    }
    logger.error(`Failed to overwrite "${email}": ${result.msg}`);
    return "failed";
  }

  async logout(): Promise<void> {
    if (!this.cookie) return;

    try {
      // logout is now POST (with CSRF), not GET
      const response = await this.request("/logout", { method: "POST" });
      if (response.ok) {
        console.log("Successfully logged out from 3x-ui");
      }
    } catch (e) {
      console.error("Logout error (non-critical):", e);
    } finally {
      this.cookie = null;
      this.csrfToken = null;
    }
  }
}
