import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import type { LegacyConfig, MultiProfileDump, ProfileDump } from "./app-config";
import { labelOf, withoutLabel } from "./link-label";

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
  /** Когда подписку последний раз успешно отдали клиенту (ms epoch); null — ни разу. */
  lastFetchedAt: number | null;
};

export type ConnectionRecord = {
  id: number;
  name: string;
  template: string;
  nodeId: number | null;
  createdAt: number;
};
export type HostRecord = {
  id: number;
  name: string;
  url: string;
  createdAt: number;
};

export type ServerRecord = {
  connectionId?: number;
  displayName?: string | null;
  name: string;
  sortOrder: number;
  template: string;
  createdAt: number;
  nodeId: number | null;
};

export type NodeType = "xui" | "naive" | "shadowsocks" | "mieru" | "xray";

export type NodeRecord = {
  id: number;
  name: string;
  url: string;
  secret: string;
  inboundId: number;
  type: NodeType;
  hostId?: number;
  backendPath?: string;
  createdAt: number;
};

export interface Storage {
  setDisplayName(
    profile: string,
    name: string,
    displayName: string | null,
    owner: number,
  ): void;
  queueRemoval(nodeId: number, name: string, uuid: string, owner: number): void;
  pendingRemovals(
    nodeId: number,
    owner: number,
  ): { clientName: string; userUuid: string }[];
  clearRemovals(nodeId: number, owner: number, uuids?: string[]): void;
  transaction<T>(fn: () => T): T;
  listConnections(ownerId: number): ConnectionRecord[];
  saveConnection(
    id: number | null,
    name: string,
    template: string,
    nodeId: number | null,
    ownerId: number,
  ): number;
  deleteConnection(id: number, ownerId: number): void;
  assignConnection(
    id: number,
    profile: string,
    included: boolean,
    ownerId: number,
  ): void;
  listHosts(ownerId: number): HostRecord[];
  exportHosts(ownerId: number): (HostRecord & { secret: string })[];
  saveHost(
    id: number | null,
    name: string,
    url: string,
    secret: string,
    ownerId: number,
  ): number;
  deleteHost(id: number, ownerId: number): void;
  saveService(
    id: number | null,
    hostId: number,
    name: string,
    path: string,
    type: NodeType,
    inboundId: number,
    ownerId: number,
  ): number;
  /** Reuses the host's service bound to the same backend (path + inbound for 3x-ui) or creates one. */
  findOrCreateService(
    hostId: number,
    type: NodeType,
    path: string,
    inboundId: number,
    preferredName: string,
    ownerId: number,
  ): number;
  /** Services are an implementation detail of servers; drop the ones nothing points at anymore. */
  pruneUnusedServices(ownerId: number, keep?: Iterable<number>): void;
  // Admin user methods
  getPrimaryAdmin(): AdminUserRecord;
  getAdminUserByUsername(username: string): AdminUserRecord | null;
  getAdminUserById(id: number): AdminUserRecord | null;
  listAdminUsers(): Omit<AdminUserRecord, "passwordHash">[];
  createAdminUser(
    username: string,
    passwordHash: string,
    createdAt: number,
  ): AdminUserRecord;
  updateAdminUser(
    id: number,
    updates: { username?: string; passwordHash?: string },
  ): boolean;
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
  addUser(
    profileName: string,
    clientName: string,
    subscriptionToken: string,
    userUuid: string,
    createdAt: number,
    ownerId: number,
  ): void;
  renameUser(
    profileName: string,
    oldName: string,
    newName: string,
    ownerId: number,
  ): boolean;
  setUserUuid(
    profileName: string,
    clientName: string,
    userUuid: string,
    ownerId: number,
  ): boolean;
  setUserCredentials(
    profileName: string,
    clientName: string,
    credentials: Record<string, string>,
    ownerId: number,
  ): boolean;
  recordSubscriptionFetch(
    subscriptionToken: string,
    fetchedAt: number,
  ): boolean;
  removeUser(profileName: string, clientName: string, ownerId: number): boolean;

  // Server methods (all scoped by ownerId via profile)
  listServers(profileName: string, ownerId: number): string[];
  listServerRecords(profileName: string, ownerId: number): ServerRecord[];
  getServerUrl(
    profileName: string,
    name: string,
    ownerId: number,
  ): string | null;
  addServer(
    profileName: string,
    name: string,
    template: string,
    createdAt: number,
    ownerId: number,
    nodeId?: number | null,
  ): void;
  renameServer(
    profileName: string,
    oldName: string,
    newName: string,
    ownerId: number,
  ): boolean;
  setServerUrl(
    profileName: string,
    name: string,
    template: string,
    ownerId: number,
  ): boolean;
  setServerNode(
    profileName: string,
    name: string,
    nodeId: number | null,
    ownerId: number,
  ): boolean;
  removeServer(profileName: string, name: string, ownerId: number): boolean;
  reorderServers(profileName: string, names: string[], ownerId: number): void;

  // Node methods (all scoped by ownerId)
  listNodes(ownerId: number): NodeRecord[];
  getNode(id: number, ownerId: number): NodeRecord | null;
  addNode(
    name: string,
    url: string,
    secret: string,
    inboundId: number,
    ownerId: number,
    createdAt: number,
    type?: NodeType,
  ): NodeRecord;
  updateNode(
    id: number,
    ownerId: number,
    updates: Partial<
      Pick<NodeRecord, "name" | "url" | "secret" | "inboundId" | "type">
    >,
  ): boolean;
  removeNode(id: number, ownerId: number): boolean;
  listNodesForProfile(profileName: string, ownerId: number): NodeRecord[];

  // Import/export
  replaceProfileFromFullDump(
    profileName: string,
    dump: ProfileDump,
    ownerId: number,
  ): void;
  mergeProfileFromFullDump(
    profileName: string,
    dump: ProfileDump,
    ownerId: number,
  ): void;
  mergeProfileFromLegacyConfig(
    profileName: string,
    config: LegacyConfig,
    subLinkSecret: string,
    ownerId: number,
  ): void;
  mergeAllFromMultiProfileDump(dump: MultiProfileDump, ownerId: number): void;

  close(): void;
}

/** Мешок кредов хранится как JSON-текст; битое значение не должно ронять раздачу. */
function parseCredentials(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export class SqliteStorage implements Storage {
  private readonly db: Database;

  public constructor(
    path: string,
    private readonly primaryAdminUsername: string,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
    // БД делят два процесса (sub-сервер и админка), а sub-сервер пишет на каждой
    // выдаче подписки (last_fetched_at). Без таймаута конкурентная запись сразу
    // падает с SQLITE_BUSY вместо того, чтобы подождать освобождения лока.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.initialize();
  }

  /**
   * ALTER TABLE ... ADD COLUMN, idempotent across processes. The sub server and the admin
   * server share this DB and usually start together, so the other process may add the
   * column between our PRAGMA check and the ALTER — that's success, not a startup crash.
   */
  private addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): void {
    const cols = this.db.query(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (cols.some((c) => c.name === column)) return;
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("duplicate column name"))
        return;
      throw err;
    }
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
    this.addColumnIfMissing(
      "servers",
      "node_id",
      "INTEGER REFERENCES nodes(id) ON DELETE SET NULL",
    );

    // 5. Migration: add owner_id to profiles (recreate table to change UNIQUE constraint)
    const profileCols = this.db.query("PRAGMA table_info(profiles)").all() as {
      name: string;
    }[];
    if (!profileCols.some((c) => c.name === "owner_id")) {
      const primaryAdminId = (
        this.db
          .query("SELECT id FROM admin_users WHERE is_primary = 1")
          .get() as { id: number }
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
    const nodeCols = this.db.query("PRAGMA table_info(nodes)").all() as {
      name: string;
    }[];
    if (!nodeCols.some((c) => c.name === "owner_id")) {
      const primaryAdminId = (
        this.db
          .query("SELECT id FROM admin_users WHERE is_primary = 1")
          .get() as { id: number }
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
    this.addColumnIfMissing(
      "users",
      "credentials",
      "TEXT NOT NULL DEFAULT '{}'",
    );

    // 6b. Migration: node provider type. Checked after migration 6, which may have just
    // recreated the nodes table without this column.
    this.addColumnIfMissing("nodes", "type", "TEXT NOT NULL DEFAULT 'xui'");

    // 6c. Migration: last successful subscription fetch per user (nullable — "never").
    this.addColumnIfMissing("users", "last_fetched_at", "INTEGER");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, template TEXT NOT NULL, node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_connections (
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        name TEXT NOT NULL, sort_order INTEGER NOT NULL, PRIMARY KEY(profile_id, name),
        UNIQUE(profile_id, connection_id)
      );
    `);
    this.addColumnIfMissing("profile_connections", "display_name", "TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS pending_node_removals(
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,owner_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      client_name TEXT NOT NULL,user_uuid TEXT NOT NULL,PRIMARY KEY(node_id,user_uuid))`);
    this.addColumnIfMissing(
      "nodes",
      "host_id",
      "INTEGER REFERENCES hosts(id) ON DELETE CASCADE",
    );
    this.addColumnIfMissing(
      "nodes",
      "backend_path",
      "TEXT NOT NULL DEFAULT ''",
    );
    this.db
      .transaction(() => {
        this.normalizeHosts();
        // Migrate once, atomically. Definitions match by exact template AND service, never by name alone.
        if (
          this.db
            .query(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='servers'",
            )
            .get()
        ) {
          const rows = this.db
            .query(
              `SELECT s.*, p.owner_id FROM servers s JOIN profiles p ON p.id=s.profile_id ORDER BY s.rowid`,
            )
            .all() as any[];
          for (const row of rows) {
            let id = this.findOrCreateConnection(
              row.name,
              row.template,
              row.node_id,
              row.created_at,
              row.owner_id,
            );
            if (
              this.db
                .query(
                  "SELECT 1 FROM profile_connections WHERE profile_id=?1 AND connection_id=?2",
                )
                .get(row.profile_id, id)
            )
              id = Number(
                this.db
                  .query(
                    "INSERT INTO connections(owner_id,name,template,node_id,created_at) VALUES (?1,?2,?3,?4,?5)",
                  )
                  .run(
                    row.owner_id,
                    row.name,
                    row.template,
                    row.node_id,
                    row.created_at,
                  ).lastInsertRowid,
              );
            this.db
              .query(
                "INSERT INTO profile_connections(profile_id,connection_id,name,sort_order) VALUES (?1,?2,?3,?4)",
              )
              .run(row.profile_id, id, row.name, row.sort_order);
          }
          this.db.exec("DROP TABLE servers");
        }
        // One-time cleanup of the 1.6.0 migration (schema version 0 → 1).
        const { user_version } = this.db
          .query("PRAGMA user_version")
          .get() as { user_version: number };
        if (user_version < 1) {
          this.mergeLabelVariants();
          this.normalizeMembershipNames();
          this.db.exec("PRAGMA user_version = 1");
        }
      })
      .immediate();

    // 7. Seed "main" profile for primary admin if not present
    const primaryAdminId = (
      this.db
        .query("SELECT id FROM admin_users WHERE is_primary = 1")
        .get() as { id: number }
    ).id;
    const mainExists = this.db
      .query(
        "SELECT 1 FROM profiles WHERE name = 'main' AND owner_id = ?1 LIMIT 1",
      )
      .get(primaryAdminId);
    if (!mainExists) {
      this.db
        .query(
          "INSERT INTO profiles (owner_id, name, created_at) VALUES (?1, ?2, ?3)",
        )
        .run(primaryAdminId, "main", Date.now());
    }
  }

  // Admin user methods

  public setDisplayName(
    profile: string,
    name: string,
    displayName: string | null,
    owner: number,
  ): void {
    this.db
      .query(
        "UPDATE profile_connections SET display_name=?1 WHERE profile_id=?2 AND name=?3",
      )
      .run(displayName, this.profileId(profile, owner), name);
  }
  public queueRemoval(
    nodeId: number,
    name: string,
    uuid: string,
    owner: number,
  ): void {
    if (!this.getNode(nodeId, owner)) throw new Error("Unknown service");
    this.db
      .query(
        "INSERT OR REPLACE INTO pending_node_removals VALUES (?1,?2,?3,?4)",
      )
      .run(nodeId, owner, name, uuid);
  }
  public pendingRemovals(
    nodeId: number,
    owner: number,
  ): { clientName: string; userUuid: string }[] {
    return this.db
      .query(
        "SELECT client_name AS clientName,user_uuid AS userUuid FROM pending_node_removals WHERE node_id=?1 AND owner_id=?2",
      )
      .all(nodeId, owner) as { clientName: string; userUuid: string }[];
  }
  public clearRemovals(nodeId: number, owner: number, uuids?: string[]): void {
    if (uuids) {
      for (const uuid of uuids)
        this.db
          .query(
            "DELETE FROM pending_node_removals WHERE node_id=?1 AND owner_id=?2 AND user_uuid=?3",
          )
          .run(nodeId, owner, uuid);
      return;
    }
    this.db
      .query(
        "DELETE FROM pending_node_removals WHERE node_id=?1 AND owner_id=?2",
      )
      .run(nodeId, owner);
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

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
      .all() as {
      id: number;
      username: string;
      is_primary: number;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      isPrimary: r.is_primary === 1,
      createdAt: r.created_at,
    }));
  }

  public createAdminUser(
    username: string,
    passwordHash: string,
    createdAt: number,
  ): AdminUserRecord {
    try {
      this.db
        .query(
          "INSERT INTO admin_users (username, password_hash, is_primary, created_at) VALUES (?1, ?2, 0, ?3)",
        )
        .run(username, passwordHash, createdAt);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(`Admin user "${username}" already exists.`);
      }
      throw err;
    }
    const newUser = this.getAdminUserByUsername(username)!;
    this.db
      .query(
        "INSERT INTO profiles (owner_id, name, created_at) VALUES (?1, 'main', ?2)",
      )
      .run(newUser.id, createdAt);
    return newUser;
  }

  public updateAdminUser(
    id: number,
    updates: { username?: string; passwordHash?: string },
  ): boolean {
    const tx = this.db.transaction(() => {
      let changed = false;
      if (updates.username !== undefined) {
        try {
          const result = this.db
            .query(
              "UPDATE admin_users SET username = ?1 WHERE id = ?2 AND is_primary = 0",
            )
            .run(updates.username, id);
          if (result.changes > 0) changed = true;
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes("UNIQUE constraint failed")
          ) {
            throw new Error(`Username "${updates.username}" is already taken.`);
          }
          throw err;
        }
      }
      if (updates.passwordHash !== undefined) {
        const result = this.db
          .query(
            "UPDATE admin_users SET password_hash = ?1 WHERE id = ?2 AND is_primary = 0",
          )
          .run(updates.passwordHash, id);
        if (result.changes > 0) changed = true;
      }
      return changed;
    });
    return tx() as boolean;
  }

  public deleteAdminUser(id: number): boolean {
    const result = this.db
      .query("DELETE FROM admin_users WHERE id = ?1 AND is_primary = 0")
      .run(id);
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
        .query(
          "INSERT INTO profiles (owner_id, name, created_at) VALUES (?1, ?2, ?3)",
        )
        .run(ownerId, name, createdAt);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(`Profile "${name}" already exists.`);
      }
      throw err;
    }
  }

  public renameProfile(
    name: string,
    newName: string,
    ownerId: number,
  ): boolean {
    const result = this.db
      .query("UPDATE profiles SET name = ?1 WHERE name = ?2 AND owner_id = ?3")
      .run(newName, name, ownerId);
    return result.changes > 0;
  }

  public renameProfileById(
    id: number,
    newName: string,
    ownerId: number,
  ): boolean {
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
         u.credentials AS credentials, u.created_at AS createdAt, u.last_fetched_at AS lastFetchedAt
         FROM users u JOIN profiles p ON p.id = u.profile_id
         WHERE p.name = ?1 AND p.owner_id = ?2 ORDER BY u.created_at DESC, u.client_name`,
      )
      .all(profileName, ownerId) as (Omit<UserRecord, "credentials"> & {
      credentials: string;
    })[];
    return rows.map((row) => ({
      ...row,
      credentials: parseCredentials(row.credentials),
    }));
  }

  public getUserBySubscriptionToken(
    subscriptionToken: string,
  ): UserRecord | null {
    const row = this.db
      .query(
        `SELECT p.name AS profileName, p.owner_id AS ownerId, u.client_name AS clientName,
         u.subscription_token AS subscriptionToken, u.user_uuid AS userUuid,
         u.credentials AS credentials, u.created_at AS createdAt, u.last_fetched_at AS lastFetchedAt
         FROM users u JOIN profiles p ON p.id = u.profile_id
         WHERE u.subscription_token = ?1`,
      )
      .get(subscriptionToken) as
      | (Omit<UserRecord, "credentials"> & { credentials: string })
      | null;
    return row
      ? { ...row, credentials: parseCredentials(row.credentials) }
      : null;
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
        .run(
          profileName,
          clientName,
          subscriptionToken,
          userUuid,
          createdAt,
          ownerId,
        );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(`User "${clientName}" already exists.`);
      }
      throw err;
    }
  }

  public renameUser(
    profileName: string,
    oldName: string,
    newName: string,
    ownerId: number,
  ): boolean {
    const result = this.db
      .query(
        `UPDATE users SET client_name = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2 AND owner_id = ?4) AND client_name = ?3`,
      )
      .run(newName, profileName, oldName, ownerId);
    return result.changes > 0;
  }

  public setUserUuid(
    profileName: string,
    clientName: string,
    userUuid: string,
    ownerId: number,
  ): boolean {
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
        .get(profileName, clientName, ownerId) as {
        credentials: string;
      } | null;
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

  public recordSubscriptionFetch(
    subscriptionToken: string,
    fetchedAt: number,
  ): boolean {
    const result = this.db
      .query(
        "UPDATE users SET last_fetched_at = ?1 WHERE subscription_token = ?2",
      )
      .run(fetchedAt, subscriptionToken);
    return result.changes > 0;
  }

  public removeUser(
    profileName: string,
    clientName: string,
    ownerId: number,
  ): boolean {
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

  public listServerRecords(
    profileName: string,
    ownerId: number,
  ): ServerRecord[] {
    return this.db
      .query(
        `SELECT m.name, m.display_name AS displayName, m.sort_order AS sortOrder, c.template, c.created_at AS createdAt,
      c.node_id AS nodeId, c.id AS connectionId FROM profile_connections m
      JOIN connections c ON c.id=m.connection_id JOIN profiles p ON p.id=m.profile_id
      WHERE p.name=?1 AND p.owner_id=?2 ORDER BY m.sort_order, m.rowid`,
      )
      .all(profileName, ownerId) as ServerRecord[];
  }

  public getServerUrl(
    profileName: string,
    name: string,
    ownerId: number,
  ): string | null {
    return (
      this.listServerRecords(profileName, ownerId).find((s) => s.name === name)
        ?.template ?? null
    );
  }

  private profileId(name: string, ownerId: number): number {
    const p = this.getProfile(name, ownerId);
    if (!p) throw new Error(`Unknown profile: ${name}`);
    return p.id;
  }

  private findOrCreateConnection(
    name: string,
    template: string,
    nodeId: number | null,
    createdAt: number,
    ownerId: number,
  ): number {
    const existing = this.db
      .query(
        "SELECT id FROM connections WHERE owner_id=?1 AND template=?2 AND node_id IS ?3 ORDER BY id LIMIT 1",
      )
      .get(ownerId, template, nodeId) as { id: number } | null;
    if (existing) return existing.id;
    return Number(
      this.db
        .query(
          "INSERT INTO connections(owner_id,name,template,node_id,created_at) VALUES (?1,?2,?3,?4,?5)",
        )
        .run(ownerId, name, template, nodeId, createdAt).lastInsertRowid,
    );
  }

  public addServer(
    profileName: string,
    name: string,
    template: string,
    createdAt: number,
    ownerId: number,
    nodeId: number | null = null,
  ): void {
    this.db.transaction(() => {
      if (nodeId !== null && !this.getNode(nodeId, ownerId))
        throw new Error("Unknown service");
      const pid = this.profileId(profileName, ownerId);
      if (
        this.listServerRecords(profileName, ownerId).some(
          (s) => s.name === name,
        )
      )
        throw new Error(`Server "${name}" already exists.`);
      let id = this.findOrCreateConnection(
        name,
        template,
        nodeId,
        createdAt,
        ownerId,
      );
      if (
        this.listServerRecords(profileName, ownerId).some(
          (s) => s.connectionId === id,
        )
      )
        id = this.saveConnection(null, name, template, nodeId, ownerId);
      this.db
        .query(
          `INSERT INTO profile_connections(profile_id,connection_id,name,sort_order) VALUES (?1,?2,?3,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM profile_connections WHERE profile_id=?1))`,
        )
        .run(pid, id, name);
    })();
  }

  public setServerNode(
    profile: string,
    name: string,
    nodeId: number | null,
    ownerId: number,
  ): boolean {
    const c = this.listServerRecords(profile, ownerId).find(
      (s) => s.name === name,
    );
    if (!c) return false;
    this.saveConnection(c.connectionId!, name, c.template, nodeId, ownerId);
    return true;
  }
  public renameServer(
    profile: string,
    oldName: string,
    newName: string,
    ownerId: number,
  ): boolean {
    return (
      this.db
        .query(
          "UPDATE profile_connections SET name=?1 WHERE profile_id=?2 AND name=?3",
        )
        .run(newName, this.profileId(profile, ownerId), oldName).changes > 0
    );
  }
  public setServerUrl(
    profile: string,
    name: string,
    template: string,
    ownerId: number,
  ): boolean {
    const c = this.listServerRecords(profile, ownerId).find(
      (s) => s.name === name,
    );
    if (!c) return false;
    this.saveConnection(c.connectionId!, name, template, c.nodeId, ownerId);
    return true;
  }
  public removeServer(profile: string, name: string, ownerId: number): boolean {
    return (
      this.db
        .query(
          "DELETE FROM profile_connections WHERE profile_id=?1 AND name=?2",
        )
        .run(this.profileId(profile, ownerId), name).changes > 0
    );
  }
  public reorderServers(
    profile: string,
    names: string[],
    ownerId: number,
  ): void {
    this.db.transaction(() => {
      const pid = this.profileId(profile, ownerId);
      names.forEach((name, i) =>
        this.db
          .query(
            "UPDATE profile_connections SET sort_order=?1 WHERE profile_id=?2 AND name=?3",
          )
          .run(i, pid, name),
      );
    })();
  }

  public listConnections(ownerId: number): ConnectionRecord[] {
    return this.db
      .query(
        "SELECT id,name,template,node_id AS nodeId,created_at AS createdAt FROM connections WHERE owner_id=?1 ORDER BY id",
      )
      .all(ownerId) as ConnectionRecord[];
  }
  public saveConnection(
    id: number | null,
    name: string,
    template: string,
    nodeId: number | null,
    ownerId: number,
  ): number {
    if (nodeId !== null && !this.getNode(nodeId, ownerId))
      throw new Error("Unknown service");
    if (id === null)
      return Number(
        this.db
          .query(
            "INSERT INTO connections(owner_id,name,template,node_id,created_at) VALUES (?1,?2,?3,?4,?5)",
          )
          .run(ownerId, name, template, nodeId, Date.now()).lastInsertRowid,
      );
    const before = this.db
      .query("SELECT name FROM connections WHERE id=?1 AND owner_id=?2")
      .get(id, ownerId) as { name: string } | null;
    if (
      !this.db
        .query(
          "UPDATE connections SET name=?1,template=?2,node_id=?3 WHERE id=?4 AND owner_id=?5",
        )
        .run(name, template, nodeId, id, ownerId).changes
    )
      throw new Error("Unknown connection");
    // Profile entries that still carry the server's name follow a rename; custom ones stay.
    if (before && before.name !== name) {
      const profiles = this.db
        .query(
          "SELECT profile_id AS profileId FROM profile_connections WHERE connection_id=?1 AND name=?2",
        )
        .all(id, before.name) as { profileId: number }[];
      for (const p of profiles) this.renameMembership(p.profileId, id, name);
    }
    return id;
  }
  public deleteConnection(id: number, ownerId: number): void {
    this.db
      .query("DELETE FROM connections WHERE id=?1 AND owner_id=?2")
      .run(id, ownerId);
  }
  public assignConnection(
    id: number,
    profile: string,
    included: boolean,
    ownerId: number,
  ): void {
    const c = this.listConnections(ownerId).find((c) => c.id === id);
    if (!c) throw new Error("Unknown connection");
    const pid = this.profileId(profile, ownerId);
    if (!included) {
      this.db
        .query(
          "DELETE FROM profile_connections WHERE profile_id=?1 AND connection_id=?2",
        )
        .run(pid, id);
      return;
    }
    if (
      this.listServerRecords(profile, ownerId).some(
        (s) => s.connectionId === id,
      )
    )
      return;
    let name = c.name;
    let n = 2;
    while (
      this.listServerRecords(profile, ownerId).some((s) => s.name === name)
    )
      name = `${c.name} (${n++})`;
    this.db
      .query(
        `INSERT INTO profile_connections(profile_id,connection_id,name,sort_order) VALUES (?1,?2,?3,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM profile_connections WHERE profile_id=?1))`,
      )
      .run(pid, id, name);
  }

  /**
   * The 1.6.0 migration shared connections only on an exact template match, so a server
   * whose profiles differed just by the label (#…, profile= for mieru) stayed split.
   * Fold such copies into the oldest one and keep each profile's label as its link-name
   * override. Copies that share a profile, or that nobody uses, are left alone.
   */
  private mergeLabelVariants(): void {
    const rows = this.db
      .query(
        "SELECT id, owner_id AS owner, node_id AS nodeId, template FROM connections ORDER BY id",
      )
      .all() as {
      id: number;
      owner: number;
      nodeId: number | null;
      template: string;
    }[];
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = JSON.stringify([row.owner, row.nodeId, withoutLabel(row.template)]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const membersOf = (id: number) =>
      this.db
        .query(
          "SELECT profile_id AS profileId, display_name AS displayName FROM profile_connections WHERE connection_id=?1",
        )
        .all(id) as { profileId: number; displayName: string | null }[];
    for (const [canonical, ...rest] of groups.values()) {
      if (!canonical || !rest.length) continue;
      const label = labelOf(canonical.template);
      const used = new Set(membersOf(canonical.id).map((m) => m.profileId));
      for (const other of rest) {
        const members = membersOf(other.id);
        const otherLabel = labelOf(other.template);
        if (!members.length || members.some((m) => used.has(m.profileId)))
          continue;
        // Without a label there is nothing to carry over as an override.
        if (otherLabel === null && label !== null) continue;
        for (const m of members) {
          if (m.displayName === null && otherLabel !== label)
            this.db
              .query(
                "UPDATE profile_connections SET display_name=?1 WHERE profile_id=?2 AND connection_id=?3",
              )
              .run(otherLabel, m.profileId, other.id);
          this.db
            .query(
              "UPDATE profile_connections SET connection_id=?1 WHERE profile_id=?2 AND connection_id=?3",
            )
            .run(canonical.id, m.profileId, other.id);
          used.add(m.profileId);
        }
        this.db.query("DELETE FROM connections WHERE id=?1").run(other.id);
      }
    }
  }

  /** Per-profile entry names are internal keys now; align them with the server name where free. */
  private normalizeMembershipNames(): void {
    const rows = this.db
      .query(
        "SELECT m.profile_id AS profileId, m.connection_id AS connectionId, c.name FROM profile_connections m JOIN connections c ON c.id=m.connection_id WHERE m.name<>c.name",
      )
      .all() as { profileId: number; connectionId: number; name: string }[];
    for (const r of rows) this.renameMembership(r.profileId, r.connectionId, r.name);
  }

  /** Renames one profile entry unless another entry of that profile already has the name. */
  private renameMembership(
    profileId: number,
    connectionId: number,
    name: string,
  ): void {
    this.db
      .query(
        `UPDATE profile_connections SET name=?1 WHERE profile_id=?2 AND connection_id=?3
         AND NOT EXISTS (SELECT 1 FROM profile_connections WHERE profile_id=?2 AND name=?1)`,
      )
      .run(name, profileId, connectionId);
  }

  private normalizeHosts(): void {
    const nodes = this.db
      .query("SELECT * FROM nodes WHERE host_id IS NULL")
      .all() as any[];
    for (const node of nodes) {
      const url = new URL(node.url);
      const base = url.origin;
      const path = url.pathname.replace(/\/$/, "");
      let h = this.db
        .query(
          "SELECT id FROM hosts WHERE owner_id=?1 AND url=?2 AND secret=?3",
        )
        .get(node.owner_id, base, node.secret) as { id: number } | null;
      if (!h)
        h = {
          id: Number(
            this.db
              .query(
                "INSERT INTO hosts(owner_id,name,url,secret,created_at) VALUES (?1,?2,?3,?4,?5)",
              )
              .run(
                node.owner_id,
                url.hostname,
                base,
                node.secret,
                node.created_at,
              ).lastInsertRowid,
          ),
        };
      this.db
        .query("UPDATE nodes SET host_id=?1,backend_path=?2 WHERE id=?3")
        .run(h.id, path, node.id);
    }
  }
  public listHosts(ownerId: number): HostRecord[] {
    return this.db
      .query(
        "SELECT id,name,url,created_at AS createdAt FROM hosts WHERE owner_id=?1 ORDER BY id",
      )
      .all(ownerId) as HostRecord[];
  }
  public exportHosts(ownerId: number): (HostRecord & { secret: string })[] {
    return this.db
      .query(
        "SELECT id,name,url,secret,created_at AS createdAt FROM hosts WHERE owner_id=?1 ORDER BY id",
      )
      .all(ownerId) as (HostRecord & { secret: string })[];
  }
  public saveHost(
    id: number | null,
    name: string,
    url: string,
    secret: string,
    ownerId: number,
  ): number {
    if (id === null) {
      if (!secret) throw new Error("Agent secret is required");
      return Number(
        this.db
          .query(
            "INSERT INTO hosts(owner_id,name,url,secret,created_at) VALUES (?1,?2,?3,?4,?5)",
          )
          .run(ownerId, name, url.replace(/\/$/, ""), secret, Date.now())
          .lastInsertRowid,
      );
    }
    if (
      !this.db
        .query(
          "UPDATE hosts SET name=?1,url=?2,secret=CASE WHEN ?3='' THEN secret ELSE ?3 END WHERE id=?4 AND owner_id=?5",
        )
        .run(name, url.replace(/\/$/, ""), secret, id, ownerId).changes
    )
      throw new Error("Unknown host");
    return id;
  }
  /** Deletes the host with its servers. Nothing is sent to the agent. */
  public deleteHost(id: number, ownerId: number): void {
    this.db.transaction(() => {
      // connections.node_id is ON DELETE SET NULL; without this the host's servers would
      // silently turn into agent-less links instead of going away with the host.
      this.db
        .query(
          "DELETE FROM connections WHERE owner_id=?2 AND node_id IN (SELECT id FROM nodes WHERE host_id=?1 AND owner_id=?2)",
        )
        .run(id, ownerId);
      this.db
        .query("DELETE FROM nodes WHERE host_id=?1 AND owner_id=?2")
        .run(id, ownerId);
      this.db
        .query("DELETE FROM hosts WHERE id=?1 AND owner_id=?2")
        .run(id, ownerId);
    })();
  }
  public findOrCreateService(
    hostId: number,
    type: NodeType,
    path: string,
    inboundId: number,
    preferredName: string,
    ownerId: number,
  ): number {
    const existing = this.listNodes(ownerId).find(
      (n) =>
        n.hostId === hostId &&
        n.backendPath === path &&
        (n.type !== "xui" || type !== "xui" || n.inboundId === inboundId),
    );
    if (existing) {
      if (existing.type !== type)
        throw new Error(
          `Backend ${path || "(default)"} on this host is already used by a ${existing.type} server`,
        );
      return existing.id;
    }
    // nodes.name is globally unique (legacy constraint), so suffix on collision.
    let name = preferredName;
    for (
      let n = 2;
      this.db.query("SELECT 1 FROM nodes WHERE name=?1").get(name);
      n++
    )
      name = `${preferredName}-${n}`;
    return this.saveService(
      null,
      hostId,
      name,
      path,
      type,
      inboundId,
      ownerId,
    );
  }
  public pruneUnusedServices(ownerId: number, keep: Iterable<number> = []): void {
    const kept = new Set(keep);
    const unused = this.db
      .query(
        `SELECT id FROM nodes n WHERE owner_id=?1
         AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.node_id=n.id)
         AND NOT EXISTS (SELECT 1 FROM pending_node_removals r WHERE r.node_id=n.id)`,
      )
      .all(ownerId) as { id: number }[];
    for (const { id } of unused)
      if (!kept.has(id))
        this.db.query("DELETE FROM nodes WHERE id=?1").run(id);
  }
  public saveService(
    id: number | null,
    hostId: number,
    name: string,
    path: string,
    type: NodeType,
    inboundId: number,
    ownerId: number,
  ): number {
    const host = this.db
      .query("SELECT * FROM hosts WHERE id=?1 AND owner_id=?2")
      .get(hostId, ownerId) as any;
    if (!host) throw new Error("Unknown host");
    if (
      this.listNodes(ownerId).some(
        (n) =>
          n.id !== id &&
          n.hostId === hostId &&
          n.backendPath === path &&
          (type !== "xui" || n.type !== "xui" || n.inboundId === inboundId),
      )
    )
      throw new Error(
        "This backend is already configured; create another connection variant instead",
      );
    if (id === null) {
      id = Number(
        this.db
          .query(
            "INSERT INTO nodes(owner_id,name,url,secret,inbound_id,type,created_at,host_id,backend_path) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
          )
          .run(
            ownerId,
            name,
            host.url + path,
            host.secret,
            inboundId,
            type,
            Date.now(),
            hostId,
            path,
          ).lastInsertRowid,
      );
    }
    if (
      !this.db
        .query(
          "UPDATE nodes SET name=?1,type=?2,inbound_id=?3,host_id=?4,backend_path=?5 WHERE id=?6 AND owner_id=?7",
        )
        .run(name, type, inboundId, hostId, path, id, ownerId).changes
    )
      throw new Error("Unknown service");
    return id;
  }

  // Import/export methods

  private importNodes(
    nodes: NonNullable<ProfileDump["NODES"]>,
    ownerId: number,
  ): void {
    for (const node of nodes) {
      const existing = this.listNodes(ownerId).find(
        (n) => n.name === node.name,
      );
      if (!existing)
        this.addNode(
          node.name,
          node.url,
          node.secret,
          node.inboundId,
          ownerId,
          node.createdAt,
          node.type ?? "xui",
        );
      else if (node.createdAt > existing.createdAt) {
        this.db
          .query(
            "UPDATE nodes SET url=?1,secret=?2,inbound_id=?3,type=?4,created_at=?5,host_id=NULL WHERE id=?6",
          )
          .run(
            node.url,
            node.secret,
            node.inboundId,
            node.type ?? "xui",
            node.createdAt,
            existing.id,
          );
      }
    }
    this.normalizeHosts();
    for (const node of nodes)
      if (node.hostName) {
        const n = this.listNodes(ownerId).find((n) => n.name === node.name);
        if (n?.hostId)
          this.db
            .query("UPDATE hosts SET name=?1 WHERE id=?2 AND owner_id=?3")
            .run(node.hostName, n.hostId, ownerId);
      }
  }
  public replaceProfileFromFullDump(
    profile: string,
    dump: ProfileDump,
    ownerId: number,
  ): void {
    this.db.transaction(() => {
      const pid = this.profileId(profile, ownerId);
      this.db.query("DELETE FROM users WHERE profile_id=?1").run(pid);
      this.db
        .query("DELETE FROM profile_connections WHERE profile_id=?1")
        .run(pid);
      this.mergeProfileFromFullDump(profile, dump, ownerId);
    })();
  }
  public mergeProfileFromFullDump(
    profile: string,
    dump: ProfileDump,
    ownerId: number,
    connectionKeys = new Map<string, number>(),
  ): void {
    this.db.transaction(() => {
      this.importNodes(dump.NODES ?? [], ownerId);
      const pid = this.profileId(profile, ownerId);
      for (const u of dump.USERS)
        this.db
          .query(
            `INSERT INTO users(profile_id,client_name,subscription_token,user_uuid,credentials,created_at)
        VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(profile_id,client_name) DO UPDATE SET
        subscription_token=excluded.subscription_token,user_uuid=excluded.user_uuid,credentials=excluded.credentials,created_at=excluded.created_at
        WHERE excluded.created_at>users.created_at`,
          )
          .run(
            pid,
            u.clientName,
            u.subscriptionToken,
            u.userUuid,
            JSON.stringify(u.credentials ?? {}),
            u.createdAt,
          );
      for (const c of dump.SERVERS) {
        const old = this.listServerRecords(profile, ownerId).find(
          (s) => s.name === c.name,
        );
        if (old && old.createdAt >= c.createdAt) continue;
        if (old) this.removeServer(profile, c.name, ownerId);
        const node = this.listNodes(ownerId).find((n) => n.name === c.nodeName);
        const shared = c.connectionKey
          ? connectionKeys.get(c.connectionKey)
          : undefined;
        if (shared !== undefined)
          this.db
            .query(
              "INSERT INTO profile_connections(profile_id,connection_id,name,sort_order) VALUES (?1,?2,?3,?4)",
            )
            .run(pid, shared, c.name, c.sortOrder);
        else
          this.addServer(
            profile,
            c.name,
            c.template,
            c.createdAt,
            ownerId,
            node?.id ?? null,
          );
        this.setDisplayName(profile, c.name, c.displayName ?? null, ownerId);
        this.db
          .query(
            "UPDATE profile_connections SET sort_order=?1 WHERE profile_id=?2 AND name=?3",
          )
          .run(c.sortOrder, pid, c.name);
      }
    })();
  }
  public mergeProfileFromLegacyConfig(
    profile: string,
    config: LegacyConfig,
    secret: string,
    ownerId: number,
  ): void {
    this.db.transaction(() => {
      for (const [name, uuid] of Object.entries(config.USERS))
        if (
          !this.listUsers(profile, ownerId).some((u) => u.clientName === name)
        )
          this.addUser(
            profile,
            name,
            createHmac("sha256", secret)
              .update(`${profile}:${name}`)
              .digest("base64url"),
            uuid,
            Date.now(),
            ownerId,
          );
      let n = this.listServerRecords(profile, ownerId).length;
      for (const template of config.SERVERS) {
        if (this.listServers(profile, ownerId).includes(template)) continue;
        let name: string;
        do {
          name = `server-${++n}`;
        } while (
          this.listServerRecords(profile, ownerId).some((s) => s.name === name)
        );
        this.addServer(profile, name, template, Date.now(), ownerId);
      }
    })();
  }
  public mergeAllFromMultiProfileDump(
    dump: MultiProfileDump,
    ownerId: number,
  ): void {
    this.db.transaction(() => {
      for (const h of dump.hosts ?? []) {
        const old = this.db
          .query(
            "SELECT id FROM hosts WHERE owner_id=?1 AND url=?2 AND secret=?3",
          )
          .get(ownerId, h.url, h.secret) as { id: number } | null;
        if (!old) this.saveHost(null, h.name, h.url, h.secret, ownerId);
      }
      this.importNodes(dump.nodes ?? [], ownerId);
      const connectionKeys = new Map<string, number>();
      const claimed = new Set<number>();
      for (const c of dump.connections ?? []) {
        const nodeId =
          this.listNodes(ownerId).find((n) => n.name === c.nodeName)?.id ??
          null;
        const existing = this.listConnections(ownerId).find(
          (x) =>
            !claimed.has(x.id) &&
            x.name === c.name &&
            x.template === c.template &&
            x.nodeId === nodeId,
        );
        const id =
          existing?.id ??
          Number(
            this.db
              .query(
                "INSERT INTO connections(owner_id,name,template,node_id,created_at) VALUES (?1,?2,?3,?4,?5)",
              )
              .run(ownerId, c.name, c.template, nodeId, c.createdAt)
              .lastInsertRowid,
          );
        connectionKeys.set(c.key, id);
        claimed.add(id);
      }
      for (const [profile, data] of Object.entries(dump.profiles)) {
        if (!this.getProfile(profile, ownerId))
          this.createProfile(profile, ownerId, Date.now());
        this.mergeProfileFromFullDump(profile, data, ownerId, connectionKeys);
      }
    })();
  }

  // Node methods

  public listNodes(ownerId: number): NodeRecord[] {
    return this.db
      .query(
        "SELECT n.id,n.name,h.url || n.backend_path AS url,h.secret,n.inbound_id AS inboundId,n.type,n.created_at AS createdAt,n.host_id AS hostId,n.backend_path AS backendPath FROM nodes n JOIN hosts h ON h.id=n.host_id WHERE n.owner_id=?1 ORDER BY n.created_at,n.id",
      )
      .all(ownerId) as NodeRecord[];
  }

  public getNode(id: number, ownerId: number): NodeRecord | null {
    return (
      (this.db
        .query(
          "SELECT n.id,n.name,h.url || n.backend_path AS url,h.secret,n.inbound_id AS inboundId,n.type,n.created_at AS createdAt,n.host_id AS hostId,n.backend_path AS backendPath FROM nodes n JOIN hosts h ON h.id=n.host_id WHERE n.id=?1 AND n.owner_id=?2",
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
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(`Node "${name}" already exists.`);
      }
      throw err;
    }
    this.normalizeHosts();
    return this.db
      .query(
        "SELECT id, name, url, secret, inbound_id AS inboundId, type, created_at AS createdAt FROM nodes WHERE name = ?1 AND owner_id = ?2",
      )
      .get(name, ownerId) as NodeRecord;
  }

  public updateNode(
    id: number,
    ownerId: number,
    updates: Partial<
      Pick<NodeRecord, "name" | "url" | "secret" | "inboundId" | "type">
    >,
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
            .query(
              "UPDATE nodes SET secret = ?1 WHERE id = ?2 AND owner_id = ?3",
            )
            .run(updates.secret, id, ownerId).changes > 0
        )
          changed = true;
      }
      if (updates.inboundId !== undefined) {
        if (
          this.db
            .query(
              "UPDATE nodes SET inbound_id = ?1 WHERE id = ?2 AND owner_id = ?3",
            )
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
      if (updates.url !== undefined || updates.secret !== undefined) {
        const current = this.getNode(id, ownerId);
        if (current)
          this.db
            .query("UPDATE nodes SET url=?1,secret=?2,host_id=NULL WHERE id=?3")
            .run(
              updates.url ?? current.url,
              updates.secret ?? current.secret,
              id,
            );
        this.normalizeHosts();
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

  public listNodesForProfile(
    profileName: string,
    ownerId: number,
  ): NodeRecord[] {
    const ids = new Set(
      this.listServerRecords(profileName, ownerId).map((s) => s.nodeId),
    );
    return this.listNodes(ownerId).filter((n) => ids.has(n.id));
  }

  public close(): void {
    this.db.close();
  }
}

export function buildProfileDump(
  storage: Storage,
  profileName: string,
  ownerId: number,
): ProfileDump {
  const nodes = storage.listNodesForProfile(profileName, ownerId);
  const nodeNameById = new Map(nodes.map((n) => [n.id, n.name]));
  return {
    USERS: storage
      .listUsers(profileName, ownerId)
      .map(
        ({
          clientName,
          userUuid,
          subscriptionToken,
          credentials,
          createdAt,
        }) => ({
          clientName,
          userUuid,
          subscriptionToken,
          credentials,
          createdAt,
        }),
      ),
    SERVERS: storage
      .listServerRecords(profileName, ownerId)
      .map(({ name, sortOrder, template, createdAt, nodeId, displayName }) => ({
        displayName,
        name,
        sortOrder,
        template,
        createdAt,
        nodeName: nodeId != null ? (nodeNameById.get(nodeId) ?? null) : null,
      })),
    NODES: nodes.map(
      ({ name, url, secret, inboundId, type, createdAt, hostId }) => ({
        hostName: storage.listHosts(ownerId).find((h) => h.id === hostId)?.name,
        name,
        url,
        secret,
        inboundId,
        type,
        createdAt,
      }),
    ),
  };
}

export function buildMultiProfileDump(
  storage: Storage,
  ownerId: number,
): MultiProfileDump {
  const profiles = storage.listProfiles(ownerId);
  const allNodes = storage.listNodes(ownerId);
  const nodeNameById = new Map(allNodes.map((n) => [n.id, n.name]));
  const result: MultiProfileDump = {
    profiles: {},
    hosts: storage.exportHosts(ownerId).map(({ id, ...host }) => host),
    connections: storage.listConnections(ownerId).map((c) => ({
      key: `connection-${c.id}`,
      name: c.name,
      template: c.template,
      nodeName: c.nodeId === null ? null : (nodeNameById.get(c.nodeId) ?? null),
      createdAt: c.createdAt,
    })),
    nodes: allNodes.map(
      ({ name, url, secret, inboundId, type, createdAt, hostId }) => ({
        hostName: storage.listHosts(ownerId).find((h) => h.id === hostId)?.name,
        name,
        url,
        secret,
        inboundId,
        type,
        createdAt,
      }),
    ),
  };
  for (const profile of profiles) {
    const users = storage
      .listUsers(profile.name, ownerId)
      .map(
        ({
          clientName,
          userUuid,
          subscriptionToken,
          credentials,
          createdAt,
        }) => ({
          clientName,
          userUuid,
          subscriptionToken,
          credentials,
          createdAt,
        }),
      );
    const servers = storage
      .listServerRecords(profile.name, ownerId)
      .map(
        ({
          name,
          sortOrder,
          template,
          createdAt,
          nodeId,
          connectionId,
          displayName,
        }) => ({
          displayName,
          connectionKey: `connection-${connectionId}`,
          name,
          sortOrder,
          template,
          createdAt,
          nodeName: nodeId != null ? (nodeNameById.get(nodeId) ?? null) : null,
        }),
      );
    result.profiles[profile.name] = { USERS: users, SERVERS: servers };
  }
  return result;
}
