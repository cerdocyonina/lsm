import { logger } from "./logger";

export interface XUIConfig {
  host: string;
  user: string;
  password: string;
}

export class XUIService {
  private baseUrl: string;
  private cookie: string | null = null;

  constructor(private config: XUIConfig) {
    this.baseUrl = config.host.replace(/\/+$/, "");
  }

  private async request(path: string, options: BunFetchRequestInit = {}) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;

    const headers = {
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
      ...((options.headers as any) || {}),
    };

    const response = await fetch(url, {
      ...options,
      tls: { rejectUnauthorized: false },
      redirect: path === "/login" ? "manual" : "follow",
      headers: headers,
    });

    if (!response.ok && response.status !== 302) {
      throw new Error(
        `Request to ${path} failed with status: ${response.status}`,
      );
    }

    return response;
  }

  async login(): Promise<void> {
    const params = new URLSearchParams();
    params.append("username", this.config.user);
    params.append("password", this.config.password);

    const response = await this.request("/login", {
      method: "POST",
      body: params,
    });

    if (!response.ok) {
      throw new Error(`Login failed with status: ${response.status}`);
    }

    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) {
      throw new Error("No cookie received from 3x-ui");
    }

    this.cookie = setCookie.split(";")[0]!;
    console.log("Successfully logged in to 3x-ui");
  }

  private async getInboundIdByName(name: string): Promise<number> {
    const response = await this.request("/panel/api/inbounds/list");

    const data = (await response.json()) as any;
    if (!data.success) {
      throw new Error("Failed to fetch inbounds list");
    }

    const inbound = data.obj.find((i: any) => i.remark === name);
    if (!inbound) {
      throw new Error(`Inbound with name "${name}" not found`);
    }

    return inbound.id;
  }

  async getInboundClients(inboundId: number): Promise<any[]> {
    const response = await this.request(`/panel/api/inbounds/get/${inboundId}`);
    const data = (await response.json()) as any;
    if (!data.success) return [];

    const settings = JSON.parse(data.obj.settings);
    return settings.clients || [];
  }

  async syncUser(
    inboundId: number,
    email: string,
    uuid: string,
    onConflict: "skip" | "overwrite" | "keep-both" = "skip",
  ): Promise<"added" | "overwritten" | "skipped" | "kept-both" | "failed"> {
    if (!this.cookie) await this.login();

    const clients = await this.getInboundClients(inboundId);
    const existingClient = clients.find((c) => c.email === email);

    if (existingClient) {
      if (onConflict === "skip") {
        logger.warn(`User "${email}" already exists. Skipping...`);
        return "skipped";
      }

      if (onConflict === "overwrite") {
        return await this.updateUser(inboundId, existingClient.id, email, uuid);
      }

      // keep-both: find an available suffixed name
      const existingEmails = new Set(clients.map((c: any) => c.email as string));
      let suffix = 1;
      let candidate = `${email}_${suffix}`;
      while (existingEmails.has(candidate)) {
        suffix++;
        candidate = `${email}_${suffix}`;
      }
      const result = await this.addNewUser(inboundId, candidate, uuid);
      if (result === "added") {
        logger.info(`User "${email}" already exists — added as "${candidate}".`);
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
    const clientSettings = {
      clients: [
        {
          id: uuid,
          flow: "xtls-rprx-vision",
          email: email,
          limitIp: 0,
          totalGB: 0,
          expiryTime: 0,
          enable: true,
          tgId: "",
          subId: "",
        },
      ],
    };

    const response = await this.request("/panel/api/inbounds/addClient", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: inboundId,
        settings: JSON.stringify(clientSettings),
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
    oldUuid: string,
    email: string,
    newUuid: string,
  ): Promise<"overwritten" | "failed"> {
    const clientSettings = {
      clients: [
        {
          id: newUuid,
          flow: "xtls-rprx-vision",
          email: email,
          limitIp: 0,
          totalGB: 0,
          expiryTime: 0,
          enable: true,
          tgId: "",
          subId: "",
        },
      ],
    };

    const response = await this.request(
      `/panel/api/inbounds/updateClient/${oldUuid}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: inboundId,
          settings: JSON.stringify(clientSettings),
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
      const response = await this.request("/logout", {
        method: "GET",
      });

      if (response.ok) {
        console.log("Successfully logged out from 3x-ui");
      }
    } catch (e) {
      console.error("Logout error (non-critical):", e);
    } finally {
      this.cookie = null;
    }
  }
}
