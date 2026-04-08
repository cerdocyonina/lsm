import { Database } from "bun:sqlite";
import type { AppConfig } from "./app-config";

export type UserRecord = {
  clientName: string;
  userUuid: string;
};

export interface Storage {
  listUsers(): UserRecord[];
  getUserUuid(clientName: string): string | null;
  addUser(clientName: string, userUuid: string): void;
  removeUser(clientName: string): boolean;
  listServers(): string[];
  replaceFromConfig(config: AppConfig): void;
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
        "SELECT client_name AS clientName, user_uuid AS userUuid FROM users ORDER BY client_name",
      )
      .all() as UserRecord[];
  }

  public getUserUuid(clientName: string): string | null {
    const row = this.db
      .query("SELECT user_uuid AS userUuid FROM users WHERE client_name = ?1")
      .get(clientName) as { userUuid: string } | null;

    return row?.userUuid ?? null;
  }

  public addUser(clientName: string, userUuid: string): void {
    this.db
      .query(
        "INSERT INTO users (client_name, user_uuid) VALUES (?1, ?2) ON CONFLICT(client_name) DO UPDATE SET user_uuid = excluded.user_uuid",
      )
      .run(clientName, userUuid);
  }

  public removeUser(clientName: string): boolean {
    const result = this.db
      .query("DELETE FROM users WHERE client_name = ?1")
      .run(clientName);

    return result.changes > 0;
  }

  public listServers(): string[] {
    const rows = this.db
      .query("SELECT template FROM servers ORDER BY sort_order, id")
      .all() as { template: string }[];

    return rows.map((row) => row.template);
  }

  public replaceFromConfig(config: AppConfig): void {
    const tx = this.db.transaction((appConfig: AppConfig) => {
      this.db.query("DELETE FROM users").run();
      this.db.query("DELETE FROM servers").run();

      const insertUser = this.db.query(
        "INSERT INTO users (client_name, user_uuid) VALUES (?1, ?2)",
      );
      for (const [clientName, userUuid] of Object.entries(appConfig.USERS)) {
        insertUser.run(clientName, userUuid);
      }

      const insertServer = this.db.query(
        "INSERT INTO servers (sort_order, template) VALUES (?1, ?2)",
      );
      appConfig.SERVERS.forEach((template, index) => {
        insertServer.run(index, template);
      });
    });

    tx(config);
  }

  public close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        client_name TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
