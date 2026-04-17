import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import type { FullDump, LegacyConfig } from "./app-config";

export type UserRecord = {
  clientName: string;
  subscriptionToken: string;
  userUuid: string;
  createdAt: number;
};

export type ServerRecord = {
  name: string;
  sortOrder: number;
  template: string;
  createdAt: number;
};

export interface Storage {
  listUsers(): UserRecord[];
  getUserBySubscriptionToken(subscriptionToken: string): UserRecord | null;
  getUserUuid(clientName: string): string | null;
  addUser(clientName: string, subscriptionToken: string, userUuid: string, createdAt: number): void;
  renameUser(oldName: string, newName: string): boolean;
  setUserUuid(clientName: string, userUuid: string): boolean;
  removeUser(clientName: string): boolean;
  listServers(): string[];
  listServerRecords(): ServerRecord[];
  getServerUrl(name: string): string | null;
  addServer(name: string, template: string, createdAt: number): void;
  renameServer(oldName: string, newName: string): boolean;
  setServerUrl(name: string, template: string): boolean;
  removeServer(name: string): boolean;
  reorderServers(names: string[]): void;
  replaceFromConfig(config: LegacyConfig, subLinkSecret: string): void;
  replaceFromFullDump(dump: FullDump): void;
  mergeFromFullDump(dump: FullDump): void;
  mergeFromLegacyConfig(config: LegacyConfig, subLinkSecret: string): void;
  close(): void;
}

export class SqliteStorage implements Storage {
  private readonly db: Database;

  public constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.initialize();
  }

  public listUsers(): UserRecord[] {
    return this.db
      .query(
        "SELECT client_name AS clientName, subscription_token AS subscriptionToken, user_uuid AS userUuid, created_at AS createdAt FROM users ORDER BY created_at DESC, client_name",
      )
      .all() as UserRecord[];
  }

  public getUserBySubscriptionToken(subscriptionToken: string): UserRecord | null {
    return (
      (this.db
        .query(
          "SELECT client_name AS clientName, subscription_token AS subscriptionToken, user_uuid AS userUuid, created_at AS createdAt FROM users WHERE subscription_token = ?1",
        )
        .get(subscriptionToken) as UserRecord | null) ?? null
    );
  }

  public getUserUuid(clientName: string): string | null {
    const row = this.db
      .query("SELECT user_uuid AS userUuid FROM users WHERE client_name = ?1")
      .get(clientName) as { userUuid: string } | null;

    return row?.userUuid ?? null;
  }

  public addUser(
    clientName: string,
    subscriptionToken: string,
    userUuid: string,
    createdAt: number,
  ): void {
    try {
      this.db
        .query(
          "INSERT INTO users (client_name, subscription_token, user_uuid, created_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .run(clientName, subscriptionToken, userUuid, createdAt);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`User "${clientName}" already exists.`);
      }
      throw err;
    }
  }

  public renameUser(oldName: string, newName: string): boolean {
    const result = this.db
      .query("UPDATE users SET client_name = ?1 WHERE client_name = ?2")
      .run(newName, oldName);

    return result.changes > 0;
  }

  public setUserUuid(clientName: string, userUuid: string): boolean {
    const result = this.db
      .query("UPDATE users SET user_uuid = ?1 WHERE client_name = ?2")
      .run(userUuid, clientName);

    return result.changes > 0;
  }

  public removeUser(clientName: string): boolean {
    const result = this.db
      .query("DELETE FROM users WHERE client_name = ?1")
      .run(clientName);

    return result.changes > 0;
  }

  public listServers(): string[] {
    const rows = this.listServerRecords();

    return rows.map((row) => row.template);
  }

  public listServerRecords(): ServerRecord[] {
    return this.db
      .query(
        "SELECT name, sort_order AS sortOrder, template, created_at AS createdAt FROM servers ORDER BY sort_order, rowid",
      )
      .all() as ServerRecord[];
  }

  public getServerUrl(name: string): string | null {
    const row = this.db
      .query("SELECT template FROM servers WHERE name = ?1")
      .get(name) as { template: string } | null;

    return row?.template ?? null;
  }

  public addServer(name: string, template: string, createdAt: number): void {
    const row = this.db
      .query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder FROM servers")
      .get() as { nextSortOrder: number };
    try {
      this.db
        .query("INSERT INTO servers (name, sort_order, template, created_at) VALUES (?1, ?2, ?3, ?4)")
        .run(name, row.nextSortOrder, template, createdAt);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`Server "${name}" already exists.`);
      }
      throw err;
    }
  }

  public renameServer(oldName: string, newName: string): boolean {
    const result = this.db
      .query("UPDATE servers SET name = ?1 WHERE name = ?2")
      .run(newName, oldName);

    return result.changes > 0;
  }

  public setServerUrl(name: string, template: string): boolean {
    const result = this.db
      .query("UPDATE servers SET template = ?1 WHERE name = ?2")
      .run(template, name);

    return result.changes > 0;
  }

  public removeServer(name: string): boolean {
    const result = this.db
      .query("DELETE FROM servers WHERE name = ?1")
      .run(name);

    return result.changes > 0;
  }

  public reorderServers(names: string[]): void {
    const tx = this.db.transaction((nameList: string[]) => {
      const update = this.db.query("UPDATE servers SET sort_order = ?1 WHERE name = ?2");
      nameList.forEach((name, index) => {
        update.run(index, name);
      });
    });
    tx(names);
  }

  public replaceFromConfig(config: LegacyConfig, subLinkSecret: string): void {
    const tx = this.db.transaction(
      (appConfig: LegacyConfig, secret: string) => {
        this.db.query("DELETE FROM users").run();
        this.db.query("DELETE FROM servers").run();

        const now = Date.now();
        const insertUser = this.db.query(
          "INSERT INTO users (client_name, subscription_token, user_uuid, created_at) VALUES (?1, ?2, ?3, ?4)",
        );
        for (const [clientName, userUuid] of Object.entries(appConfig.USERS) as [string, string][]) {
          insertUser.run(
            clientName,
            createHmac("sha256", secret).update(clientName).digest("base64url"),
            userUuid,
            now,
          );
        }

        const insertServer = this.db.query(
          "INSERT INTO servers (name, sort_order, template, created_at) VALUES (?1, ?2, ?3, ?4)",
        );
        appConfig.SERVERS.forEach((template: string, index: number) => {
          insertServer.run(`server-${index + 1}`, index, template, now);
        });
      },
    );

    tx(config, subLinkSecret);
  }

  public replaceFromFullDump(dump: FullDump): void {
    const tx = this.db.transaction((d: FullDump) => {
      this.db.query("DELETE FROM users").run();
      this.db.query("DELETE FROM servers").run();

      const insertUser = this.db.query(
        "INSERT INTO users (client_name, subscription_token, user_uuid, created_at) VALUES (?1, ?2, ?3, ?4)",
      );
      for (const user of d.USERS) {
        insertUser.run(user.clientName, user.subscriptionToken, user.userUuid, user.createdAt);
      }

      const insertServer = this.db.query(
        "INSERT INTO servers (name, sort_order, template, created_at) VALUES (?1, ?2, ?3, ?4)",
      );
      for (const server of d.SERVERS) {
        insertServer.run(server.name, server.sortOrder, server.template, server.createdAt);
      }
    });

    tx(dump);
  }

  // Merge incoming full dump into the DB. For each record:
  //   - not in DB → insert
  //   - in DB with older createdAt → update to incoming
  //   - in DB with equal or newer createdAt → keep DB version (no-op)
  public mergeFromFullDump(dump: FullDump): void {
    const tx = this.db.transaction((d: FullDump) => {
      const upsertUser = this.db.query(`
        INSERT INTO users (client_name, subscription_token, user_uuid, created_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(client_name) DO UPDATE SET
          subscription_token = excluded.subscription_token,
          user_uuid = excluded.user_uuid,
          created_at = excluded.created_at
        WHERE excluded.created_at > users.created_at
      `);
      for (const user of d.USERS) {
        upsertUser.run(user.clientName, user.subscriptionToken, user.userUuid, user.createdAt);
      }

      const upsertServer = this.db.query(`
        INSERT INTO servers (name, sort_order, template, created_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(name) DO UPDATE SET
          sort_order = excluded.sort_order,
          template = excluded.template,
          created_at = excluded.created_at
        WHERE excluded.created_at > servers.created_at
      `);
      for (const server of d.SERVERS) {
        upsertServer.run(server.name, server.sortOrder, server.template, server.createdAt);
      }
    });

    tx(dump);
  }

  // Merge legacy config into the DB.
  //   Users: insert if clientName not present (keep existing, no createdAt to compare).
  //   Servers: insert if template not already present (matched by template value).
  public mergeFromLegacyConfig(config: LegacyConfig, subLinkSecret: string): void {
    const tx = this.db.transaction((appConfig: LegacyConfig, secret: string) => {
      const now = Date.now();

      const insertUser = this.db.query(`
        INSERT INTO users (client_name, subscription_token, user_uuid, created_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(client_name) DO NOTHING
      `);
      for (const [clientName, userUuid] of Object.entries(appConfig.USERS) as [string, string][]) {
        insertUser.run(
          clientName,
          createHmac("sha256", secret).update(clientName).digest("base64url"),
          userUuid,
          now,
        );
      }

      const existingTemplates = new Set(
        (this.db.query("SELECT template FROM servers").all() as { template: string }[])
          .map((r) => r.template),
      );
      const existingNames = new Set(
        (this.db.query("SELECT name FROM servers").all() as { name: string }[])
          .map((r) => r.name),
      );
      let counter = existingNames.size;
      for (const template of appConfig.SERVERS) {
        if (existingTemplates.has(template)) continue;
        counter++;
        let name = `server-${counter}`;
        while (existingNames.has(name)) {
          counter++;
          name = `server-${counter}`;
        }
        this.addServer(name, template, now);
        existingNames.add(name);
        existingTemplates.add(template);
      }
    });

    tx(config, subLinkSecret);
  }

  public close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        client_name TEXT PRIMARY KEY,
        subscription_token TEXT NOT NULL UNIQUE,
        user_uuid TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS servers (
        name TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        template TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  }
}

export function buildFullDump(storage: Storage): FullDump {
  return {
    USERS: storage.listUsers().map(({ clientName, userUuid, subscriptionToken, createdAt }) => ({
      clientName,
      userUuid,
      subscriptionToken,
      createdAt,
    })),
    SERVERS: storage.listServerRecords().map(({ name, sortOrder, template, createdAt }) => ({
      name,
      sortOrder,
      template,
      createdAt,
    })),
  };
}
