import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import type { AppConfig } from "./app-config";

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
  addServer(name: string, template: string): void;
  renameServer(oldName: string, newName: string): boolean;
  setServerUrl(name: string, template: string): boolean;
  removeServer(name: string): boolean;
  replaceFromConfig(config: AppConfig, subLinkSecret: string): void;
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
    this.db
      .query(
        "INSERT INTO users (client_name, subscription_token, user_uuid, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(client_name) DO UPDATE SET user_uuid = excluded.user_uuid",
      )
      .run(clientName, subscriptionToken, userUuid, createdAt);
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
        "SELECT name, sort_order AS sortOrder, template FROM servers ORDER BY sort_order, rowid",
      )
      .all() as ServerRecord[];
  }

  public getServerUrl(name: string): string | null {
    const row = this.db
      .query("SELECT template FROM servers WHERE name = ?1")
      .get(name) as { template: string } | null;

    return row?.template ?? null;
  }

  public addServer(name: string, template: string): void {
    const row = this.db
      .query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder FROM servers")
      .get() as { nextSortOrder: number };
    this.db
      .query("INSERT INTO servers (name, sort_order, template) VALUES (?1, ?2, ?3)")
      .run(name, row.nextSortOrder, template);
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

  public replaceFromConfig(config: AppConfig, subLinkSecret: string): void {
    const tx = this.db.transaction(
      (appConfig: AppConfig, secret: string) => {
      this.db.query("DELETE FROM users").run();
      this.db.query("DELETE FROM servers").run();

      const now = Date.now();
      const insertUser = this.db.query(
        "INSERT INTO users (client_name, subscription_token, user_uuid, created_at) VALUES (?1, ?2, ?3, ?4)",
      );
      for (const [clientName, userUuid] of Object.entries(appConfig.USERS)) {
        insertUser.run(
          clientName,
          createHmac("sha256", secret).update(clientName).digest("base64url"),
          userUuid,
          now,
        );
      }

      const insertServer = this.db.query(
        "INSERT INTO servers (name, sort_order, template) VALUES (?1, ?2, ?3)",
      );
      appConfig.SERVERS.forEach((template, index) => {
        insertServer.run(`server-${index + 1}`, index, template);
      });
      },
    );

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
        template TEXT NOT NULL
      );
    `);
  }
}

export function loadStorageSnapshot(storage: Storage): {
  USERS: Record<string, string>;
  SERVERS: string[];
} {
  const users = Object.fromEntries(
    storage.listUsers().map(({ clientName, userUuid }) => [clientName, userUuid]),
  );
  const servers = storage.listServers();

  return {
    USERS: users,
    SERVERS: servers,
  };
}
