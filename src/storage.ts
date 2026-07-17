import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import type { LegacyConfig, MultiProfileDump, ProfileDump } from "./app-config";

export type AdminUserRecord = {
  id: number;
  username: string;
  passwordHash: string;
  isPrimary: boolean;
  createdAt: number;
};

export type ProfileRecord = {
  id: number;
  name: string;
  createdAt: number;
};

export type UserRecord = {
  profileName: string;
  ownerId: number;
  clientName: string;
  subscriptionToken: string;
  userUuid: string;
  credentials: Record<string, string>;
  createdAt: number;
};

export type ServerRecord = {
  name: string;
  sortOrder: number;
  template: string;
  createdAt: number;
  nodeId: number | null;
};

export type NodeType = "xui" | "naive";

export type NodeRecord = {
  id: number;
  name: string;
  url: string;
  secret: string;
  inboundId: number;
  type: NodeType;
  createdAt: number;
};

export interface Storage {
  // Admin user methods
  getPrimaryAdmin(): AdminUserRecord;
  getAdminUserByUsername(username: string): AdminUserRecord | null;
  getAdminUserById(id: number): AdminUserRecord | null;
  listAdminUsers(): Omit<AdminUserRecord, "passwordHash">[];
  createAdminUser(username: string, passwordHash: string, createdAt: number): AdminUserRecord;
  updateAdminUser(id: number, updates: { username?: string; passwordHash?: string }): boolean;
  deleteAdminUser(id: number): boolean;

  // Profile methods (all scoped by ownerId)
  listProfiles(ownerId: number): ProfileRecord[];
  getProfile(name: string, ownerId: number): ProfileRecord | null;
  getProfileById(id: number, ownerId: number): ProfileRecord | null;
  createProfile(name: string, ownerId: number, createdAt: number): void;
  renameProfile(name: string, newName: string, ownerId: number): boolean;
  renameProfileById(id: number, newName: string, ownerId: number): boolean;
  deleteProfile(name: string, ownerId: number): boolean;

  // User methods (all scoped by ownerId via profile)
  listUsers(profileName: string, ownerId: number): UserRecord[];
  getUserBySubscriptionToken(subscriptionToken: string): UserRecord | null;
  addUser(profileName: string, clientName: string, subscriptionToken: string, userUuid: string, createdAt: number, ownerId: number): void;
  renameUser(profileName: string, oldName: string, newName: string, ownerId: number): boolean;
  setUserUuid(profileName: string, clientName: string, userUuid: string, ownerId: number): boolean;
  setUserCredentials(profileName: string, clientName: string, credentials: Record<string, string>, ownerId: number): boolean;
  removeUser(profileName: string, clientName: string, ownerId: number): boolean;

  // Server methods (all scoped by ownerId via profile)
  listServers(profileName: string, ownerId: number): string[];
  listServerRecords(profileName: string, ownerId: number): ServerRecord[];
  getServerUrl(profileName: string, name: string, ownerId: number): string | null;
  addServer(profileName: string, name: string, template: string, createdAt: number, ownerId: number, nodeId?: number | null): void;
  renameServer(profileName: string, oldName: string, newName: string, ownerId: number): boolean;
  setServerUrl(profileName: string, name: string, template: string, ownerId: number): boolean;
  setServerNode(profileName: string, name: string, nodeId: number | null, ownerId: number): boolean;
  removeServer(profileName: string, name: string, ownerId: number): boolean;
  reorderServers(profileName: string, names: string[], ownerId: number): void;

  // Node methods (all scoped by ownerId)
  listNodes(ownerId: number): NodeRecord[];
  getNode(id: number, ownerId: number): NodeRecord | null;
  addNode(name: string, url: string, secret: string, inboundId: number, ownerId: number, createdAt: number, type?: NodeType): NodeRecord;
  updateNode(id: number, ownerId: number, updates: Partial<Pick<NodeRecord, "name" | "url" | "secret" | "inboundId" | "type">>): boolean;
  removeNode(id: number, ownerId: number): boolean;
  listNodesForProfile(profileName: string, ownerId: number): NodeRecord[];

  // Import/export
  replaceProfileFromFullDump(profileName: string, dump: ProfileDump, ownerId: number): void;
  mergeProfileFromFullDump(profileName: string, dump: ProfileDump, ownerId: number): void;
  mergeProfileFromLegacyConfig(profileName: string, config: LegacyConfig, subLinkSecret: string, ownerId: number): void;
  mergeAllFromMultiProfileDump(dump: MultiProfileDump, ownerId: number): void;

  close(): void;
}

/** Мешок кредов хранится как JSON-текст; битое значение не должно ронять раздачу. */
function parseCredentials(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export class SqliteStorage implements Storage {
  private readonly db: Database;

  public constructor(path: string, private readonly primaryAdminUsername: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initialize();
  }

  private initialize(): void {
    // 1. Create admin_users table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0
      );
    `);

    // 2. Seed or sync primary admin row
    const primaryRow = this.db
      .query("SELECT id, username FROM admin_users WHERE is_primary = 1")
      .get() as { id: number; username: string } | null;
    if (!primaryRow) {
      this.db
        .query(
          "INSERT INTO admin_users (username, password_hash, is_primary, created_at) VALUES (?1, 'env:', 1, ?2)",
        )
        .run(this.primaryAdminUsername, Date.now());
    } else if (primaryRow.username !== this.primaryAdminUsername) {
      this.db
        .query("UPDATE admin_users SET username = ?1 WHERE id = ?2")
        .run(this.primaryAdminUsername, primaryRow.id);
    }

    // 3. Create base tables with new schema (no-op on existing installs)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(owner_id, name)
      );
      CREATE TABLE IF NOT EXISTS users (
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        client_name TEXT NOT NULL,
        subscription_token TEXT NOT NULL UNIQUE,
        user_uuid TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, client_name)
      );
      CREATE TABLE IF NOT EXISTS servers (
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        template TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, name)
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        inbound_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0
      );
    `);

    // 4. Migration: add node_id to servers if not present
    const serverCols = this.db.query("PRAGMA table_info(servers)").all() as { name: string }[];
    if (!serverCols.some((c) => c.name === "node_id")) {
      this.db.exec(
        "ALTER TABLE servers ADD COLUMN node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL",
      );
    }

    // 5. Migration: add owner_id to profiles (recreate table to change UNIQUE constraint)
    const profileCols = this.db.query("PRAGMA table_info(profiles)").all() as { name: string }[];
    if (!profileCols.some((c) => c.name === "owner_id")) {
      const primaryAdminId = (
        this.db.query("SELECT id FROM admin_users WHERE is_primary = 1").get() as { id: number }
      ).id;
      this.db.exec("PRAGMA foreign_keys = OFF");
      const migrateProfiles = this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE profiles_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT 0,
            UNIQUE(owner_id, name)
          )
        `);
        this.db
          .query(
            "INSERT INTO profiles_new (id, owner_id, name, created_at) SELECT id, ?1, name, created_at FROM profiles",
          )
          .run(primaryAdminId);
        this.db.exec("DROP TABLE profiles");
        this.db.exec("ALTER TABLE profiles_new RENAME TO profiles");
      });
      migrateProfiles();
      this.db.exec("PRAGMA foreign_keys = ON");
    }

    // 6. Migration: add owner_id to nodes (recreate table)
    const nodeCols = this.db.query("PRAGMA table_info(nodes)").all() as { name: string }[];
    if (!nodeCols.some((c) => c.name === "owner_id")) {
      const primaryAdminId = (
        this.db.query("SELECT id FROM admin_users WHERE is_primary = 1").get() as { id: number }
      ).id;
      const migrateNodes = this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE nodes_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
            name TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL,
            secret TEXT NOT NULL,
            inbound_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT 0
          )
        `);
        this.db
          .query(
            "INSERT INTO nodes_new SELECT id, ?1, name, url, secret, inbound_id, created_at FROM nodes",
          )
          .run(primaryAdminId);
        this.db.exec("DROP TABLE nodes");
        this.db.exec("ALTER TABLE nodes_new RENAME TO nodes");
      });
      migrateNodes();
    }

    // 6a. Migration: per-user credential bag for named placeholders ({user}, {pass}, ...).
    // user_uuid stays where it is and remains the source for {uuid}.
    const userCols = this.db.query("PRAGMA table_info(users)").all() as { name: string }[];
    if (!userCols.some((c) => c.name === "credentials")) {
      this.db.exec("ALTER TABLE users ADD COLUMN credentials TEXT NOT NULL DEFAULT '{}'");
    }

    // 6b. Migration: node provider type. Re-query — migration 6 may have just
    // recreated the nodes table without this column.
    const nodeColsAfterMigration = this.db.query("PRAGMA table_info(nodes)").all() as { name: string }[];
    if (!nodeColsAfterMigration.some((c) => c.name === "type")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN type TEXT NOT NULL DEFAULT 'xui'");
    }

    // 7. Seed "main" profile for primary admin if not present
    const primaryAdminId = (
      this.db.query("SELECT id FROM admin_users WHERE is_primary = 1").get() as { id: number }
    ).id;
    const mainExists = this.db
      .query("SELECT 1 FROM profiles WHERE name = 'main' AND owner_id = ?1 LIMIT 1")
      .get(primaryAdminId);
    if (!mainExists) {
      this.db
        .query("INSERT INTO profiles (owner_id, name, created_at) VALUES (?1, ?2, ?3)")
        .run(primaryAdminId, "main", Date.now());
    }
  }

  // Admin user methods

  private mapAdminUser(row: {
    id: number;
    username: string;
    password_hash: string;
    is_primary: number;
    created_at: number;
  }): AdminUserRecord {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      isPrimary: row.is_primary === 1,
      createdAt: row.created_at,
    };
  }

  public getPrimaryAdmin(): AdminUserRecord {
    const row = this.db
      .query(
        "SELECT id, username, password_hash, is_primary, created_at FROM admin_users WHERE is_primary = 1",
      )
      .get() as {
      id: number;
      username: string;
      password_hash: string;
      is_primary: number;
      created_at: number;
    } | null;
    if (!row) throw new Error("Primary admin not found in database");
    return this.mapAdminUser(row);
  }

  public getAdminUserByUsername(username: string): AdminUserRecord | null {
    const row = this.db
      .query(
        "SELECT id, username, password_hash, is_primary, created_at FROM admin_users WHERE username = ?1",
      )
      .get(username) as {
      id: number;
      username: string;
      password_hash: string;
      is_primary: number;
      created_at: number;
    } | null;
    return row ? this.mapAdminUser(row) : null;
  }

  public getAdminUserById(id: number): AdminUserRecord | null {
    const row = this.db
      .query(
        "SELECT id, username, password_hash, is_primary, created_at FROM admin_users WHERE id = ?1",
      )
      .get(id) as {
      id: number;
      username: string;
      password_hash: string;
      is_primary: number;
      created_at: number;
    } | null;
    return row ? this.mapAdminUser(row) : null;
  }

  public listAdminUsers(): Omit<AdminUserRecord, "passwordHash">[] {
    const rows = this.db
      .query(
        "SELECT id, username, is_primary, created_at FROM admin_users ORDER BY is_primary DESC, created_at, id",
      )
      .all() as { id: number; username: string; is_primary: number; created_at: number }[];
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      isPrimary: r.is_primary === 1,
      createdAt: r.created_at,
    }));
  }

  public createAdminUser(username: string, passwordHash: string, createdAt: number): AdminUserRecord {
    try {
      this.db
        .query(
          "INSERT INTO admin_users (username, password_hash, is_primary, created_at) VALUES (?1, ?2, 0, ?3)",
        )
        .run(username, passwordHash, createdAt);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`Admin user "${username}" already exists.`);
      }
      throw err;
    }
    const newUser = this.getAdminUserByUsername(username)!;
    this.db
      .query("INSERT INTO profiles (owner_id, name, created_at) VALUES (?1, 'main', ?2)")
      .run(newUser.id, createdAt);
    return newUser;
  }

  public updateAdminUser(id: number, updates: { username?: string; passwordHash?: string }): boolean {
    const tx = this.db.transaction(() => {
      let changed = false;
      if (updates.username !== undefined) {
        try {
          const result = this.db
            .query("UPDATE admin_users SET username = ?1 WHERE id = ?2 AND is_primary = 0")
            .run(updates.username, id);
          if (result.changes > 0) changed = true;
        } catch (err) {
          if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
            throw new Error(`Username "${updates.username}" is already taken.`);
          }
          throw err;
        }
      }
      if (updates.passwordHash !== undefined) {
        const result = this.db
          .query("UPDATE admin_users SET password_hash = ?1 WHERE id = ?2 AND is_primary = 0")
          .run(updates.passwordHash, id);
        if (result.changes > 0) changed = true;
      }
      return changed;
    });
    return tx() as boolean;
  }

  public deleteAdminUser(id: number): boolean {
    const result = this.db.query("DELETE FROM admin_users WHERE id = ?1 AND is_primary = 0").run(id);
    return result.changes > 0;
  }

  // Profile methods

  public listProfiles(ownerId: number): ProfileRecord[] {
    return this.db
      .query(
        "SELECT id, name, created_at AS createdAt FROM profiles WHERE owner_id = ?1 ORDER BY created_at, id",
      )
      .all(ownerId) as ProfileRecord[];
  }

  public getProfile(name: string, ownerId: number): ProfileRecord | null {
    return (
      (this.db
        .query(
          "SELECT id, name, created_at AS createdAt FROM profiles WHERE name = ?1 AND owner_id = ?2",
        )
        .get(name, ownerId) as ProfileRecord | null) ?? null
    );
  }

  public getProfileById(id: number, ownerId: number): ProfileRecord | null {
    return (
      (this.db
        .query(
          "SELECT id, name, created_at AS createdAt FROM profiles WHERE id = ?1 AND owner_id = ?2",
        )
        .get(id, ownerId) as ProfileRecord | null) ?? null
    );
  }

  public createProfile(name: string, ownerId: number, createdAt: number): void {
    try {
      this.db
        .query("INSERT INTO profiles (owner_id, name, created_at) VALUES (?1, ?2, ?3)")
        .run(ownerId, name, createdAt);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`Profile "${name}" already exists.`);
      }
      throw err;
    }
  }

  public renameProfile(name: string, newName: string, ownerId: number): boolean {
    const result = this.db
      .query("UPDATE profiles SET name = ?1 WHERE name = ?2 AND owner_id = ?3")
      .run(newName, name, ownerId);
    return result.changes > 0;
  }

  public renameProfileById(id: number, newName: string, ownerId: number): boolean {
    const result = this.db
      .query("UPDATE profiles SET name = ?1 WHERE id = ?2 AND owner_id = ?3")
      .run(newName, id, ownerId);
    return result.changes > 0;
  }

  public deleteProfile(name: string, ownerId: number): boolean {
    const result = this.db
      .query("DELETE FROM profiles WHERE name = ?1 AND owner_id = ?2")
      .run(name, ownerId);
    return result.changes > 0;
  }

  // User methods

  public listUsers(profileName: string, ownerId: number): UserRecord[] {
    const rows = this.db
      .query(
        `SELECT p.name AS profileName, p.owner_id AS ownerId, u.client_name AS clientName,
         u.subscription_token AS subscriptionToken, u.user_uuid AS userUuid,
         u.credentials AS credentials, u.created_at AS createdAt
         FROM users u JOIN profiles p ON p.id = u.profile_id
         WHERE p.name = ?1 AND p.owner_id = ?2 ORDER BY u.created_at DESC, u.client_name`,
      )
      .all(profileName, ownerId) as (Omit<UserRecord, "credentials"> & { credentials: string })[];
    return rows.map((row) => ({ ...row, credentials: parseCredentials(row.credentials) }));
  }

  public getUserBySubscriptionToken(subscriptionToken: string): UserRecord | null {
    const row = this.db
      .query(
        `SELECT p.name AS profileName, p.owner_id AS ownerId, u.client_name AS clientName,
         u.subscription_token AS subscriptionToken, u.user_uuid AS userUuid,
         u.credentials AS credentials, u.created_at AS createdAt
         FROM users u JOIN profiles p ON p.id = u.profile_id
         WHERE u.subscription_token = ?1`,
      )
      .get(subscriptionToken) as (Omit<UserRecord, "credentials"> & { credentials: string }) | null;
    return row ? { ...row, credentials: parseCredentials(row.credentials) } : null;
  }

  public addUser(
    profileName: string,
    clientName: string,
    subscriptionToken: string,
    userUuid: string,
    createdAt: number,
    ownerId: number,
  ): void {
    try {
      this.db
        .query(
          `INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
           VALUES ((SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6), ?2, ?3, ?4, ?5)`,
        )
        .run(profileName, clientName, subscriptionToken, userUuid, createdAt, ownerId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`User "${clientName}" already exists.`);
      }
      throw err;
    }
  }

  public renameUser(profileName: string, oldName: string, newName: string, ownerId: number): boolean {
    const result = this.db
      .query(
        `UPDATE users SET client_name = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2 AND owner_id = ?4) AND client_name = ?3`,
      )
      .run(newName, profileName, oldName, ownerId);
    return result.changes > 0;
  }

  public setUserUuid(profileName: string, clientName: string, userUuid: string, ownerId: number): boolean {
    const result = this.db
      .query(
        `UPDATE users SET user_uuid = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2 AND owner_id = ?4) AND client_name = ?3`,
      )
      .run(userUuid, profileName, clientName, ownerId);
    return result.changes > 0;
  }

  /** Мержит переданные креды в существующий мешок пользователя. */
  public setUserCredentials(
    profileName: string,
    clientName: string,
    credentials: Record<string, string>,
    ownerId: number,
  ): boolean {
    const tx = this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT u.credentials AS credentials FROM users u JOIN profiles p ON p.id = u.profile_id
           WHERE p.name = ?1 AND p.owner_id = ?3 AND u.client_name = ?2`,
        )
        .get(profileName, clientName, ownerId) as { credentials: string } | null;
      if (!row) return false;

      const merged = { ...parseCredentials(row.credentials), ...credentials };
      const result = this.db
        .query(
          `UPDATE users SET credentials = ?1
           WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2 AND owner_id = ?4) AND client_name = ?3`,
        )
        .run(JSON.stringify(merged), profileName, clientName, ownerId);
      return result.changes > 0;
    });
    return tx() as boolean;
  }

  public removeUser(profileName: string, clientName: string, ownerId: number): boolean {
    const result = this.db
      .query(
        `DELETE FROM users
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?3) AND client_name = ?2`,
      )
      .run(profileName, clientName, ownerId);
    return result.changes > 0;
  }

  // Server methods

  public listServers(profileName: string, ownerId: number): string[] {
    return this.listServerRecords(profileName, ownerId).map((r) => r.template);
  }

  public listServerRecords(profileName: string, ownerId: number): ServerRecord[] {
    return this.db
      .query(
        `SELECT s.name, s.sort_order AS sortOrder, s.template, s.created_at AS createdAt, s.node_id AS nodeId
         FROM servers s JOIN profiles p ON p.id = s.profile_id
         WHERE p.name = ?1 AND p.owner_id = ?2 ORDER BY s.sort_order, s.rowid`,
      )
      .all(profileName, ownerId) as ServerRecord[];
  }

  public getServerUrl(profileName: string, name: string, ownerId: number): string | null {
    const row = this.db
      .query(
        `SELECT s.template FROM servers s JOIN profiles p ON p.id = s.profile_id
         WHERE p.name = ?1 AND s.name = ?2 AND p.owner_id = ?3`,
      )
      .get(profileName, name, ownerId) as { template: string } | null;
    return row?.template ?? null;
  }

  public addServer(
    profileName: string,
    name: string,
    template: string,
    createdAt: number,
    ownerId: number,
    nodeId: number | null = null,
  ): void {
    const row = this.db
      .query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder
         FROM servers WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?2)`,
      )
      .get(profileName, ownerId) as { nextSortOrder: number };
    try {
      this.db
        .query(
          `INSERT INTO servers (profile_id, name, sort_order, template, created_at, node_id)
           VALUES ((SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6), ?2, ?3, ?4, ?5, ?7)`,
        )
        .run(profileName, name, row.nextSortOrder, template, createdAt, ownerId, nodeId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`Server "${name}" already exists.`);
      }
      throw err;
    }
  }

  public setServerNode(profileName: string, name: string, nodeId: number | null, ownerId: number): boolean {
    const result = this.db
      .query(
        `UPDATE servers SET node_id = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2 AND owner_id = ?4) AND name = ?3`,
      )
      .run(nodeId, profileName, name, ownerId);
    return result.changes > 0;
  }

  public renameServer(profileName: string, oldName: string, newName: string, ownerId: number): boolean {
    const result = this.db
      .query(
        `UPDATE servers SET name = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2 AND owner_id = ?4) AND name = ?3`,
      )
      .run(newName, profileName, oldName, ownerId);
    return result.changes > 0;
  }

  public setServerUrl(profileName: string, name: string, template: string, ownerId: number): boolean {
    const result = this.db
      .query(
        `UPDATE servers SET template = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2 AND owner_id = ?4) AND name = ?3`,
      )
      .run(template, profileName, name, ownerId);
    return result.changes > 0;
  }

  public removeServer(profileName: string, name: string, ownerId: number): boolean {
    const result = this.db
      .query(
        `DELETE FROM servers
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?3) AND name = ?2`,
      )
      .run(profileName, name, ownerId);
    return result.changes > 0;
  }

  public reorderServers(profileName: string, names: string[], ownerId: number): void {
    const tx = this.db.transaction((pname: string, nameList: string[]) => {
      const update = this.db.query(
        `UPDATE servers SET sort_order = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2 AND owner_id = ?4) AND name = ?3`,
      );
      nameList.forEach((name, index) => {
        update.run(index, pname, name, ownerId);
      });
    });
    tx(profileName, names);
  }

  // Import/export methods

  public replaceProfileFromFullDump(profileName: string, dump: ProfileDump, ownerId: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          "DELETE FROM users WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?2)",
        )
        .run(profileName, ownerId);
      this.db
        .query(
          "DELETE FROM servers WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?2)",
        )
        .run(profileName, ownerId);

      const upsertNode = this.db.query(`
        INSERT INTO nodes (owner_id, name, url, secret, inbound_id, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(name) DO UPDATE SET
          url = excluded.url,
          secret = excluded.secret,
          inbound_id = excluded.inbound_id,
          created_at = excluded.created_at
        WHERE nodes.owner_id = ?1 AND excluded.created_at > nodes.created_at
      `);
      for (const node of dump.NODES ?? []) {
        upsertNode.run(ownerId, node.name, node.url, node.secret, node.inboundId, node.createdAt);
      }

      const insertUser = this.db.query(
        `INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
         VALUES ((SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6), ?2, ?3, ?4, ?5)`,
      );
      for (const user of dump.USERS) {
        insertUser.run(profileName, user.clientName, user.subscriptionToken, user.userUuid, user.createdAt, ownerId);
      }

      const insertServer = this.db.query(
        `INSERT INTO servers (profile_id, name, sort_order, template, created_at, node_id)
         VALUES (
           (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6),
           ?2, ?3, ?4, ?5,
           (SELECT id FROM nodes WHERE name = ?7 AND owner_id = ?6)
         )`,
      );
      for (const server of dump.SERVERS) {
        insertServer.run(profileName, server.name, server.sortOrder, server.template, server.createdAt, ownerId, server.nodeName ?? null);
      }
    });
    tx();
  }

  public mergeProfileFromFullDump(profileName: string, dump: ProfileDump, ownerId: number): void {
    const upsertNode = this.db.query(`
      INSERT INTO nodes (owner_id, name, url, secret, inbound_id, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(name) DO UPDATE SET
        url = excluded.url,
        secret = excluded.secret,
        inbound_id = excluded.inbound_id,
        created_at = excluded.created_at
      WHERE nodes.owner_id = ?1 AND excluded.created_at > nodes.created_at
    `);
    const upsertUser = this.db.query(`
      INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
      VALUES ((SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6), ?2, ?3, ?4, ?5)
      ON CONFLICT(profile_id, client_name) DO UPDATE SET
        subscription_token = excluded.subscription_token,
        user_uuid = excluded.user_uuid,
        created_at = excluded.created_at
      WHERE excluded.created_at > users.created_at
    `);
    const upsertServer = this.db.query(`
      INSERT INTO servers (profile_id, name, sort_order, template, created_at, node_id)
      VALUES (
        (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6),
        ?2, ?3, ?4, ?5,
        (SELECT id FROM nodes WHERE name = ?7 AND owner_id = ?6)
      )
      ON CONFLICT(profile_id, name) DO UPDATE SET
        sort_order = excluded.sort_order,
        template = excluded.template,
        created_at = excluded.created_at,
        node_id = excluded.node_id
      WHERE excluded.created_at > servers.created_at
    `);

    const tx = this.db.transaction(() => {
      for (const node of dump.NODES ?? []) {
        upsertNode.run(ownerId, node.name, node.url, node.secret, node.inboundId, node.createdAt);
      }
      for (const user of dump.USERS) {
        upsertUser.run(profileName, user.clientName, user.subscriptionToken, user.userUuid, user.createdAt, ownerId);
      }
      for (const server of dump.SERVERS) {
        upsertServer.run(profileName, server.name, server.sortOrder, server.template, server.createdAt, ownerId, server.nodeName ?? null);
      }
    });
    tx();
  }

  public mergeProfileFromLegacyConfig(
    profileName: string,
    config: LegacyConfig,
    subLinkSecret: string,
    ownerId: number,
  ): void {
    const tx = this.db.transaction(() => {
      const now = Date.now();

      const insertUser = this.db.query(`
        INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
        VALUES ((SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6), ?2, ?3, ?4, ?5)
        ON CONFLICT(profile_id, client_name) DO NOTHING
      `);
      for (const [clientName, userUuid] of Object.entries(config.USERS) as [string, string][]) {
        insertUser.run(
          profileName,
          clientName,
          createHmac("sha256", subLinkSecret)
            .update(`${profileName}:${clientName}`)
            .digest("base64url"),
          userUuid,
          now,
          ownerId,
        );
      }

      const existingTemplates = new Set(
        (
          this.db
            .query(
              "SELECT s.template FROM servers s JOIN profiles p ON p.id = s.profile_id WHERE p.name = ?1 AND p.owner_id = ?2",
            )
            .all(profileName, ownerId) as { template: string }[]
        ).map((r) => r.template),
      );
      const existingNames = new Set(
        (
          this.db
            .query(
              "SELECT s.name FROM servers s JOIN profiles p ON p.id = s.profile_id WHERE p.name = ?1 AND p.owner_id = ?2",
            )
            .all(profileName, ownerId) as { name: string }[]
        ).map((r) => r.name),
      );

      const getNextSortOrder = this.db.query(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder FROM servers WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?2)",
      );
      const insertServer = this.db.query(
        `INSERT INTO servers (profile_id, name, sort_order, template, created_at)
         VALUES ((SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6), ?2, ?3, ?4, ?5)`,
      );

      let counter = existingNames.size;
      for (const template of config.SERVERS) {
        if (existingTemplates.has(template)) continue;
        counter++;
        let name = `server-${counter}`;
        while (existingNames.has(name)) {
          counter++;
          name = `server-${counter}`;
        }
        const row = getNextSortOrder.get(profileName, ownerId) as { nextSortOrder: number };
        insertServer.run(profileName, name, row.nextSortOrder, template, now, ownerId);
        existingNames.add(name);
        existingTemplates.add(template);
      }
    });
    tx();
  }

  public mergeAllFromMultiProfileDump(dump: MultiProfileDump, ownerId: number): void {
    const ensureProfile = this.db.query(`
      INSERT INTO profiles (owner_id, name, created_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(owner_id, name) DO NOTHING
    `);
    const upsertNode = this.db.query(`
      INSERT INTO nodes (owner_id, name, url, secret, inbound_id, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(name) DO UPDATE SET
        url = excluded.url,
        secret = excluded.secret,
        inbound_id = excluded.inbound_id,
        created_at = excluded.created_at
      WHERE nodes.owner_id = ?1 AND excluded.created_at > nodes.created_at
    `);
    const upsertUser = this.db.query(`
      INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
      VALUES ((SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6), ?2, ?3, ?4, ?5)
      ON CONFLICT(profile_id, client_name) DO UPDATE SET
        subscription_token = excluded.subscription_token,
        user_uuid = excluded.user_uuid,
        created_at = excluded.created_at
      WHERE excluded.created_at > users.created_at
    `);
    const upsertServer = this.db.query(`
      INSERT INTO servers (profile_id, name, sort_order, template, created_at, node_id)
      VALUES (
        (SELECT id FROM profiles WHERE name = ?1 AND owner_id = ?6),
        ?2, ?3, ?4, ?5,
        (SELECT id FROM nodes WHERE name = ?7 AND owner_id = ?6)
      )
      ON CONFLICT(profile_id, name) DO UPDATE SET
        sort_order = excluded.sort_order,
        template = excluded.template,
        created_at = excluded.created_at,
        node_id = excluded.node_id
      WHERE excluded.created_at > servers.created_at
    `);

    const tx = this.db.transaction(() => {
      const now = Date.now();
      for (const node of dump.nodes ?? []) {
        upsertNode.run(ownerId, node.name, node.url, node.secret, node.inboundId, node.createdAt);
      }
      for (const [profileName, profileData] of Object.entries(dump.profiles)) {
        ensureProfile.run(ownerId, profileName, now);
        for (const user of profileData.USERS) {
          upsertUser.run(profileName, user.clientName, user.subscriptionToken, user.userUuid, user.createdAt, ownerId);
        }
        for (const server of profileData.SERVERS) {
          upsertServer.run(profileName, server.name, server.sortOrder, server.template, server.createdAt, ownerId, server.nodeName ?? null);
        }
      }
    });
    tx();
  }

  // Node methods

  public listNodes(ownerId: number): NodeRecord[] {
    return this.db
      .query(
        "SELECT id, name, url, secret, inbound_id AS inboundId, type, created_at AS createdAt FROM nodes WHERE owner_id = ?1 ORDER BY created_at, id",
      )
      .all(ownerId) as NodeRecord[];
  }

  public getNode(id: number, ownerId: number): NodeRecord | null {
    return (
      (this.db
        .query(
          "SELECT id, name, url, secret, inbound_id AS inboundId, type, created_at AS createdAt FROM nodes WHERE id = ?1 AND owner_id = ?2",
        )
        .get(id, ownerId) as NodeRecord | null) ?? null
    );
  }

  public addNode(
    name: string,
    url: string,
    secret: string,
    inboundId: number,
    ownerId: number,
    createdAt: number,
    type: NodeType = "xui",
  ): NodeRecord {
    try {
      this.db
        .query(
          "INSERT INTO nodes (owner_id, name, url, secret, inbound_id, type, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .run(ownerId, name, url, secret, inboundId, type, createdAt);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`Node "${name}" already exists.`);
      }
      throw err;
    }
    return this.db
      .query(
        "SELECT id, name, url, secret, inbound_id AS inboundId, type, created_at AS createdAt FROM nodes WHERE name = ?1 AND owner_id = ?2",
      )
      .get(name, ownerId) as NodeRecord;
  }

  public updateNode(
    id: number,
    ownerId: number,
    updates: Partial<Pick<NodeRecord, "name" | "url" | "secret" | "inboundId" | "type">>,
  ): boolean {
    const tx = this.db.transaction(() => {
      let changed = false;
      if (updates.name !== undefined) {
        if (
          this.db
            .query("UPDATE nodes SET name = ?1 WHERE id = ?2 AND owner_id = ?3")
            .run(updates.name, id, ownerId).changes > 0
        )
          changed = true;
      }
      if (updates.url !== undefined) {
        if (
          this.db
            .query("UPDATE nodes SET url = ?1 WHERE id = ?2 AND owner_id = ?3")
            .run(updates.url, id, ownerId).changes > 0
        )
          changed = true;
      }
      if (updates.secret !== undefined) {
        if (
          this.db
            .query("UPDATE nodes SET secret = ?1 WHERE id = ?2 AND owner_id = ?3")
            .run(updates.secret, id, ownerId).changes > 0
        )
          changed = true;
      }
      if (updates.inboundId !== undefined) {
        if (
          this.db
            .query("UPDATE nodes SET inbound_id = ?1 WHERE id = ?2 AND owner_id = ?3")
            .run(updates.inboundId, id, ownerId).changes > 0
        )
          changed = true;
      }
      if (updates.type !== undefined) {
        if (
          this.db
            .query("UPDATE nodes SET type = ?1 WHERE id = ?2 AND owner_id = ?3")
            .run(updates.type, id, ownerId).changes > 0
        )
          changed = true;
      }
      return changed;
    });
    return tx() as boolean;
  }

  public removeNode(id: number, ownerId: number): boolean {
    const result = this.db
      .query("DELETE FROM nodes WHERE id = ?1 AND owner_id = ?2")
      .run(id, ownerId);
    return result.changes > 0;
  }

  public listNodesForProfile(profileName: string, ownerId: number): NodeRecord[] {
    return this.db
      .query(
        `SELECT DISTINCT n.id, n.name, n.url, n.secret, n.inbound_id AS inboundId, n.type, n.created_at AS createdAt
         FROM nodes n
         JOIN servers s ON s.node_id = n.id
         JOIN profiles p ON p.id = s.profile_id
         WHERE p.name = ?1 AND p.owner_id = ?2`,
      )
      .all(profileName, ownerId) as NodeRecord[];
  }

  public close(): void {
    this.db.close();
  }
}

export function buildProfileDump(storage: Storage, profileName: string, ownerId: number): ProfileDump {
  const nodes = storage.listNodesForProfile(profileName, ownerId);
  const nodeNameById = new Map(nodes.map((n) => [n.id, n.name]));
  return {
    USERS: storage.listUsers(profileName, ownerId).map(({ clientName, userUuid, subscriptionToken, createdAt }) => ({
      clientName,
      userUuid,
      subscriptionToken,
      createdAt,
    })),
    SERVERS: storage.listServerRecords(profileName, ownerId).map(({ name, sortOrder, template, createdAt, nodeId }) => ({
      name,
      sortOrder,
      template,
      createdAt,
      nodeName: nodeId != null ? (nodeNameById.get(nodeId) ?? null) : null,
    })),
    NODES: nodes.map(({ name, url, secret, inboundId, createdAt }) => ({
      name,
      url,
      secret,
      inboundId,
      createdAt,
    })),
  };
}

export function buildMultiProfileDump(storage: Storage, ownerId: number): MultiProfileDump {
  const profiles = storage.listProfiles(ownerId);
  const allNodes = storage.listNodes(ownerId);
  const nodeNameById = new Map(allNodes.map((n) => [n.id, n.name]));
  const result: MultiProfileDump = {
    profiles: {},
    nodes: allNodes.map(({ name, url, secret, inboundId, createdAt }) => ({
      name,
      url,
      secret,
      inboundId,
      createdAt,
    })),
  };
  for (const profile of profiles) {
    const users = storage.listUsers(profile.name, ownerId).map(({ clientName, userUuid, subscriptionToken, createdAt }) => ({
      clientName,
      userUuid,
      subscriptionToken,
      createdAt,
    }));
    const servers = storage.listServerRecords(profile.name, ownerId).map(({ name, sortOrder, template, createdAt, nodeId }) => ({
      name,
      sortOrder,
      template,
      createdAt,
      nodeName: nodeId != null ? (nodeNameById.get(nodeId) ?? null) : null,
    }));
    result.profiles[profile.name] = { USERS: users, SERVERS: servers };
  }
  return result;
}
