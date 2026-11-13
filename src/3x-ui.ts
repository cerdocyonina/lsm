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
  // Whether we've made at least one successful connection and thus know the
  // panel's scheme (http vs https) is correct — see request()'s fallback.
  private schemeResolved = false;
  // In-flight login(), so concurrent callers (a bulk sync fires all users at once
  // against this one shared XUIService instance) await the SAME attempt instead of
  // each racing their own: overlapping logins each get their own session cookie from
  // 3x-ui, and whichever's cookie and CSRF-token writes land last can end up mismatched
  // (cookie from one session, token from another) — 3x-ui then 403s every request from
  // that point on, since nothing ever clears this.cookie to trigger a fresh login.
  private loginPromise: Promise<void> | null = null;
  // Tail of a FIFO chain that every request() call joins — confirmed live (x-ui.go's own
  // access log shows nothing for the rejected calls, meaning they never reach the
  // controller) that 3x-ui's session/CSRF middleware isn't safe for concurrent requests
  // on the same session: 20 concurrent client-adds against one logged-in session 401'd
  // about half of them, while 12 of the SAME calls run one-at-a-time all succeeded.
  // One in-flight request to the panel at a time sidesteps that entirely.
  private requestQueue: Promise<unknown> = Promise.resolve();

  constructor(private config: XUIConfig) {
    this.baseUrl = config.host.replace(/\/+$/, "");
  }

  // Same base URL with http<->https swapped, or null if it uses neither.
  private altBaseUrl(): string | null {
    if (this.baseUrl.startsWith("https://")) return `http://${this.baseUrl.slice(8)}`;
    if (this.baseUrl.startsWith("http://")) return `https://${this.baseUrl.slice(7)}`;
    return null;
  }

  // Thin wrapper that queues onto requestQueue (see its comment) — actual work is in
  // doRequest(). The queue link always resolves (even when the request fails) so one
  // failed call doesn't jam the chain for everything queued after it.
  private request(path: string, options: BunFetchRequestInit = {}): Promise<Response> {
    const run = this.requestQueue.then(
      () => this.doRequest(path, options),
      () => this.doRequest(path, options),
    );
    this.requestQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doRequest(path: string, options: BunFetchRequestInit = {}) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

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

    const fetchOptions: BunFetchRequestInit = {
      ...options,
      tls: { rejectUnauthorized: false },
      headers,
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${normalizedPath}`, fetchOptions);
    } catch (err) {
      // A connection-level failure (as opposed to an HTTP error status) usually
      // means the panel is up but on the OTHER scheme: XUI_HOST says https://
      // while 3x-ui — which since v3.4.0 installs without TLS unless asked —
      // serves plain HTTP, or vice-versa. Retry once on the flipped scheme and,
      // if it connects, pin it for the rest of this client's lifetime.
      const alt = this.altBaseUrl();
      if (this.schemeResolved || !alt) throw err;
      try {
        response = await fetch(`${alt}${normalizedPath}`, fetchOptions);
      } catch {
        // The flipped scheme failed too, so this wasn't a scheme mismatch —
        // the panel is simply unreachable. Report the original (configured
        // scheme) error; the fallback's error would name a URL the operator
        // never configured and send them down the wrong path.
        throw err;
      }
      this.baseUrl = alt;
    }
    this.schemeResolved = true;

    if (!response.ok) {
      throw new Error(
        `Request to ${path} failed with status: ${response.status}`,
      );
    }

    return response;
  }

  /**
   * Lightweight liveness probe against the panel's public /csrf-token endpoint.
   * Requires no credentials and is scheme-resilient (see request()), so it also
   * pins the correct http/https scheme for any later login()/API calls.
   */
  async ping(timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.request("/csrf-token", {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await response.json()) as { success?: boolean };
      if (data.success === true) return { ok: true };
      return {
        ok: false,
        error: `Unexpected /csrf-token response (success=${data.success})`,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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

  /** Serializes login() across concurrent callers — see loginPromise's comment. */
  private async ensureLoggedIn(): Promise<void> {
    if (this.cookie) return;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
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
    await this.ensureLoggedIn();

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

  async checkConflicts(emails: string[]): Promise<string[]> {
    await this.ensureLoggedIn();
    const existing = await this.getAllClientEmails();
    return emails.filter((e) => existing.has(e));
  }

  async deleteUser(email: string): Promise<"deleted" | "not_found" | "failed"> {
    await this.ensureLoggedIn();

    const exists = await this.clientExists(email);
    if (!exists) {
      logger.warn(`User "${email}" not found in 3x-ui.`);
      return "not_found";
    }

    try {
      const response = await this.request(
        `/panel/api/clients/del/${encodeURIComponent(email)}`,
        { method: "POST" },
      );
      const result = (await response.json()) as any;
      if (result.success) {
        logger.info(`User "${email}" deleted successfully.`);
        return "deleted";
      }
      logger.error(`Failed to delete "${email}": ${result.msg}`);
      return "failed";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Error calling del for "${email}": ${msg}`);
      return "failed";
    }
  }

  // ---------------------------------------------------------------------------
  // Batch sync (/sync-clients): one panel read, a UUID-aware plan, then the writes.
  // ---------------------------------------------------------------------------

  /** Every client on the panel with its UUID and inbound attachments. */
  private async listClients(needsUuid: (email: string) => boolean): Promise<PanelClient[]> {
    const response = await this.request("/panel/api/clients/list");
    const data = (await response.json()) as any;
    if (!data.success || !Array.isArray(data.obj))
      throw new Error(`Cannot list 3x-ui clients: ${data.msg ?? "unexpected response"}`);
    const clients = data.obj.map(parsePanelClient).filter((c: PanelClient | null): c is PanelClient => c !== null);
    // The list normally carries `uuid`; if this panel version omits it, ask per client —
    // but only for the ones the plan can touch.
    for (const c of clients)
      if (c.uuid === undefined && needsUuid(c.email)) {
        const full = await this.getClient(c.email);
        if (full) Object.assign(c, { uuid: full.uuid, inboundIds: c.inboundIds ?? full.inboundIds });
      }
    return clients;
  }

  private async getClient(email: string): Promise<PanelClient | null> {
    const response = await this.request(`/panel/api/clients/get/${encodeURIComponent(email)}`);
    const data = (await response.json()) as any;
    if (!data.success || data.obj == null) return null;
    const obj = data.obj;
    // Either the flat record or { client, inboundIds } depending on the panel version.
    return parsePanelClient({ ...(obj.client ?? obj), inboundIds: obj.inboundIds ?? obj.client?.inboundIds });
  }

  private async panelCall(path: string, body?: unknown): Promise<void> {
    const response = await this.request(path, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const result = (await response.json()) as any;
    if (!result.success) throw new Error(result.msg || `${path} was rejected`);
  }

  /** Partial update: the panel keeps every field the body omits. */
  private updateClient(email: string, patch: Record<string, unknown>) {
    return this.panelCall(`/panel/api/clients/update/${encodeURIComponent(email)}`, patch);
  }

  private async setClientUuid(email: string, uuid: string): Promise<void> {
    // Write-side payloads name the UUID `id`, read-side records `uuid`; try both, then check.
    for (const patch of [{ id: uuid }, { uuid }]) {
      await this.updateClient(email, patch);
      if ((await this.getClient(email))?.uuid === uuid) return;
    }
    throw new Error("panel did not apply the UUID change");
  }

  private async runStep(step: ClientStep, inboundId: number): Promise<void> {
    const attach = (email: string) =>
      this.panelCall(`/panel/api/clients/${encodeURIComponent(email)}/attach`, { inboundIds: [inboundId] });
    switch (step.kind) {
      case "add":
        if ((await this.addNewUser(inboundId, step.email, step.uuid)) !== "added") throw new Error("panel rejected the new client");
        return;
      case "keep-both":
        if ((await this.addNewUser(inboundId, step.as, step.uuid)) !== "added") throw new Error("panel rejected the new client");
        return;
      case "rename":
        await this.updateClient(step.from, { email: step.email });
        if (step.attach) await attach(step.email);
        return;
      case "overwrite":
        await this.setClientUuid(step.email, step.uuid);
        if (step.attach) await attach(step.email);
        return;
      case "attach":
        await attach(step.email);
        return;
      case "detach":
        await this.panelCall(`/panel/api/clients/${encodeURIComponent(step.email)}/detach`, { inboundIds: [inboundId] });
        return;
      case "delete":
        await this.panelCall(`/panel/api/clients/del/${encodeURIComponent(step.email)}`);
        return;
      default:
        return; // unchanged / conflict / not-found: nothing to write
    }
  }

  /**
   * Brings one inbound in line with the listed clients and removals. Clients the request
   * doesn't mention are never touched. With dryRun the plan is returned without writes.
   */
  async syncClients(req: ClientSyncRequest): Promise<{ results: ClientOutcome[] }> {
    await this.ensureLoggedIn();
    const panel = await this.listClients(relevantTo(req));
    const steps = planClientSync(panel, req);
    if (req.dryRun) return { results: steps.map((s) => ({ ...s, ok: true })) };
    const results: ClientOutcome[] = [];
    for (const step of steps) {
      try {
        await this.runStep(step, req.inboundId);
        results.push({ ...step, ok: true });
      } catch (err) {
        results.push({ ...step, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { results };
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

// ---------------------------------------------------------------------------
// Client sync planning (pure, shared by lsmnode and its tests)
// ---------------------------------------------------------------------------

/** A client LSM wants on the inbound. `legacyEmail` is the pre-2.0 plain client name. */
export type DesiredClient = { email: string; uuid: string; legacyEmail?: string };
/** A client LSM revoked; matched by UUID so a same-named stranger is never removed. */
export type ClientRemoval = { email: string; uuid: string };
export type ConflictStrategy = "skip" | "overwrite" | "keep-both";
export type ClientSyncRequest = {
  inboundId: number;
  clients: DesiredClient[];
  remove?: ClientRemoval[];
  onConflict: ConflictStrategy;
  dryRun?: boolean;
};
export type PanelClient = { email: string; uuid?: string; inboundIds?: number[] };

export type ClientStep =
  | { kind: "add"; email: string; uuid: string }
  | { kind: "rename"; email: string; from: string; uuid: string; attach: boolean }
  | { kind: "attach"; email: string; uuid: string }
  | { kind: "overwrite"; email: string; uuid: string; attach: boolean }
  | { kind: "keep-both"; email: string; as: string; uuid: string }
  | { kind: "conflict"; email: string; uuid: string; detail: string }
  | { kind: "unchanged"; email: string; uuid: string }
  | { kind: "delete"; email: string; uuid: string; reason: "revoked" | "duplicate" }
  | { kind: "detach"; email: string; uuid: string; reason: "revoked" }
  | { kind: "not-found"; email: string; uuid: string };
export type ClientOutcome = ClientStep & { ok: boolean; error?: string };

function parsePanelClient(raw: any): PanelClient | null {
  if (!raw || typeof raw.email !== "string") return null;
  const uuid = typeof raw.uuid === "string" && raw.uuid ? raw.uuid : typeof raw.id === "string" && raw.id ? raw.id : undefined;
  const inboundIds = Array.isArray(raw.inboundIds) ? raw.inboundIds.filter((n: unknown) => typeof n === "number") : undefined;
  return { email: raw.email, uuid, inboundIds };
}

/** Same user under another LSM-style name: plain legacy name, renamed profile or renamed user. */
function isEarlierName(email: string, d: DesiredClient): boolean {
  const dot = d.email.indexOf(".");
  const profile = dot > 0 ? d.email.slice(0, dot) : "";
  const legacy = d.legacyEmail;
  return (
    (legacy !== undefined && (email === legacy || email.endsWith(`.${legacy}`))) ||
    (profile !== "" && email.startsWith(`${profile}.`))
  );
}

/** Whether a revocation for `wanted` refers to the panel client `email` (either naming scheme). */
function sameName(email: string, wanted: string): boolean {
  return email === wanted || email.endsWith(`.${wanted}`) || wanted.endsWith(`.${email}`);
}

function relevantTo(req: ClientSyncRequest): (email: string) => boolean {
  return (email) =>
    req.clients.some((d) => d.email === email || isEarlierName(email, d)) ||
    (req.remove ?? []).some((r) => sameName(email, r.email));
}

/**
 * Decides what to do for each listed client. Identity is the UUID: a client already on
 * the panel under an older LSM name (e.g. plain "client1" before profile prefixes) is
 * renamed rather than duplicated, so traffic stats and limits survive.
 */
export function planClientSync(panel: PanelClient[], req: ClientSyncRequest): ClientStep[] {
  const steps: ClientStep[] = [];
  const byEmail = new Map(panel.map((c) => [c.email, c]));
  const desired = new Set(req.clients.map((c) => c.email));
  const taken = new Set(panel.map((c) => c.email));
  const claimed = new Set<string>();
  // Unknown attachments: assume attached rather than issue a speculative attach.
  const onInbound = (c: PanelClient) => !c.inboundIds || c.inboundIds.includes(req.inboundId);

  for (const d of req.clients) {
    const current = byEmail.get(d.email);
    if (current) {
      claimed.add(current.email);
      if (current.uuid === undefined) {
        steps.push({ kind: "conflict", email: d.email, uuid: d.uuid, detail: "the panel did not report this client's UUID" });
      } else if (current.uuid === d.uuid) {
        steps.push(onInbound(current) ? { kind: "unchanged", email: d.email, uuid: d.uuid } : { kind: "attach", email: d.email, uuid: d.uuid });
        // A copy left under an older name (an earlier rename, or a re-added legacy client)
        // goes away when the current client already covers all of its inbounds.
        for (const old of panel) {
          if (claimed.has(old.email) || desired.has(old.email) || old.uuid !== d.uuid || !isEarlierName(old.email, d)) continue;
          const covered = new Set([req.inboundId, ...(current.inboundIds ?? [])]);
          if (old.inboundIds && old.inboundIds.every((id) => covered.has(id))) {
            claimed.add(old.email);
            steps.push({ kind: "delete", email: old.email, uuid: d.uuid, reason: "duplicate" });
          }
        }
      } else if (req.onConflict === "overwrite") {
        steps.push({ kind: "overwrite", email: d.email, uuid: d.uuid, attach: !onInbound(current) });
      } else if (req.onConflict === "keep-both") {
        let n = 1;
        while (taken.has(`${d.email}_${n}`)) n++;
        taken.add(`${d.email}_${n}`);
        steps.push({ kind: "keep-both", email: d.email, as: `${d.email}_${n}`, uuid: d.uuid });
      } else {
        steps.push({ kind: "conflict", email: d.email, uuid: d.uuid, detail: "exists on the panel with a different UUID" });
      }
      continue;
    }
    const previous = panel.find(
      (c) => !claimed.has(c.email) && !desired.has(c.email) && c.uuid === d.uuid && isEarlierName(c.email, d),
    );
    if (previous) {
      claimed.add(previous.email);
      steps.push({ kind: "rename", email: d.email, from: previous.email, uuid: d.uuid, attach: !onInbound(previous) });
    } else {
      steps.push({ kind: "add", email: d.email, uuid: d.uuid });
    }
  }

  for (const r of req.remove ?? []) {
    const matches = panel.filter(
      (c) => !claimed.has(c.email) && !desired.has(c.email) && c.uuid === r.uuid && sameName(c.email, r.email),
    );
    const here = matches.filter(onInbound);
    if (!here.length) {
      steps.push({ kind: "not-found", email: r.email, uuid: r.uuid });
      continue;
    }
    for (const c of here) {
      claimed.add(c.email);
      // Clients are global: on several inbounds, only leave this one.
      steps.push(
        c.inboundIds && c.inboundIds.length > 1
          ? { kind: "detach", email: c.email, uuid: r.uuid, reason: "revoked" }
          : { kind: "delete", email: c.email, uuid: r.uuid, reason: "revoked" },
      );
    }
  }
  return steps;
}
