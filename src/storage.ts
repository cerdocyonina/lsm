import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import type { LegacyConfig, MultiProfileDump, ProfileDump } from "./app-config";

export type ProfileRecord = {
  id: number;
  name: string;
  createdAt: number;
};

export type UserRecord = {
  profileName: string;
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
  listProfiles(): ProfileRecord[];
  getProfile(name: string): ProfileRecord | null;
  createProfile(name: string, createdAt: number): void;
  renameProfile(name: string, newName: string): boolean;
  renameProfileById(id: number, newName: string): boolean;
  deleteProfile(name: string): boolean;

  listUsers(profileName: string): UserRecord[];
  getUserBySubscriptionToken(subscriptionToken: string): UserRecord | null;
  addUser(profileName: string, clientName: string, subscriptionToken: string, userUuid: string, createdAt: number): void;
  renameUser(profileName: string, oldName: string, newName: string): boolean;
  setUserUuid(profileName: string, clientName: string, userUuid: string): boolean;
  removeUser(profileName: string, clientName: string): boolean;

  listServers(profileName: string): string[];
  listServerRecords(profileName: string): ServerRecord[];
  getServerUrl(profileName: string, name: string): string | null;
  addServer(profileName: string, name: string, template: string, createdAt: number): void;
  renameServer(profileName: string, oldName: string, newName: string): boolean;
  setServerUrl(profileName: string, name: string, template: string): boolean;
  removeServer(profileName: string, name: string): boolean;
  reorderServers(profileName: string, names: string[]): void;

  replaceProfileFromFullDump(profileName: string, dump: ProfileDump): void;
  mergeProfileFromFullDump(profileName: string, dump: ProfileDump): void;
  mergeProfileFromLegacyConfig(profileName: string, config: LegacyConfig, subLinkSecret: string): void;
  mergeAllFromMultiProfileDump(dump: MultiProfileDump): void;

  close(): void;
}

export class SqliteStorage implements Storage {
  private readonly db: Database;

  public constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL DEFAULT 0
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
    `);
    this.db
      .query("INSERT OR IGNORE INTO profiles (name, created_at) VALUES (?1, ?2)")
      .run("main", Date.now());
  }

  // Profile methods

  public listProfiles(): ProfileRecord[] {
    return this.db
      .query("SELECT id, name, created_at AS createdAt FROM profiles ORDER BY created_at, id")
      .all() as ProfileRecord[];
  }

  public getProfile(name: string): ProfileRecord | null {
    return (
      (this.db
        .query("SELECT id, name, created_at AS createdAt FROM profiles WHERE name = ?1")
        .get(name) as ProfileRecord | null) ?? null
    );
  }

  public createProfile(name: string, createdAt: number): void {
    try {
      this.db
        .query("INSERT INTO profiles (name, created_at) VALUES (?1, ?2)")
        .run(name, createdAt);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`Profile "${name}" already exists.`);
      }
      throw err;
    }
  }

  public renameProfile(name: string, newName: string): boolean {
    const result = this.db
      .query("UPDATE profiles SET name = ?1 WHERE name = ?2")
      .run(newName, name);
    return result.changes > 0;
  }

  public renameProfileById(id: number, newName: string): boolean {
    const result = this.db
      .query("UPDATE profiles SET name = ?1 WHERE id = ?2")
      .run(newName, id);
    return result.changes > 0;
  }

  public deleteProfile(name: string): boolean {
    const result = this.db
      .query("DELETE FROM profiles WHERE name = ?1")
      .run(name);
    return result.changes > 0;
  }

  // User methods

  public listUsers(profileName: string): UserRecord[] {
    return this.db
      .query(
        `SELECT p.name AS profileName, u.client_name AS clientName, u.subscription_token AS subscriptionToken,
         u.user_uuid AS userUuid, u.created_at AS createdAt
         FROM users u JOIN profiles p ON p.id = u.profile_id
         WHERE p.name = ?1 ORDER BY u.created_at DESC, u.client_name`,
      )
      .all(profileName) as UserRecord[];
  }

  public getUserBySubscriptionToken(subscriptionToken: string): UserRecord | null {
    return (
      (this.db
        .query(
          `SELECT p.name AS profileName, u.client_name AS clientName, u.subscription_token AS subscriptionToken,
           u.user_uuid AS userUuid, u.created_at AS createdAt
           FROM users u JOIN profiles p ON p.id = u.profile_id
           WHERE u.subscription_token = ?1`,
        )
        .get(subscriptionToken) as UserRecord | null) ?? null
    );
  }

  public addUser(
    profileName: string,
    clientName: string,
    subscriptionToken: string,
    userUuid: string,
    createdAt: number,
  ): void {
    try {
      this.db
        .query(
          `INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
           VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)`,
        )
        .run(profileName, clientName, subscriptionToken, userUuid, createdAt);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`User "${clientName}" already exists.`);
      }
      throw err;
    }
  }

  public renameUser(profileName: string, oldName: string, newName: string): boolean {
    const result = this.db
      .query(
        `UPDATE users SET client_name = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2) AND client_name = ?3`,
      )
      .run(newName, profileName, oldName);
    return result.changes > 0;
  }

  public setUserUuid(profileName: string, clientName: string, userUuid: string): boolean {
    const result = this.db
      .query(
        `UPDATE users SET user_uuid = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2) AND client_name = ?3`,
      )
      .run(userUuid, profileName, clientName);
    return result.changes > 0;
  }

  public removeUser(profileName: string, clientName: string): boolean {
    const result = this.db
      .query(
        `DELETE FROM users
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1) AND client_name = ?2`,
      )
      .run(profileName, clientName);
    return result.changes > 0;
  }

  // Server methods

  public listServers(profileName: string): string[] {
    return this.listServerRecords(profileName).map((r) => r.template);
  }

  public listServerRecords(profileName: string): ServerRecord[] {
    return this.db
      .query(
        `SELECT s.name, s.sort_order AS sortOrder, s.template, s.created_at AS createdAt
         FROM servers s JOIN profiles p ON p.id = s.profile_id
         WHERE p.name = ?1 ORDER BY s.sort_order, s.rowid`,
      )
      .all(profileName) as ServerRecord[];
  }

  public getServerUrl(profileName: string, name: string): string | null {
    const row = this.db
      .query(
        `SELECT s.template FROM servers s JOIN profiles p ON p.id = s.profile_id
         WHERE p.name = ?1 AND s.name = ?2`,
      )
      .get(profileName, name) as { template: string } | null;
    return row?.template ?? null;
  }

  public addServer(profileName: string, name: string, template: string, createdAt: number): void {
    const row = this.db
      .query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder
         FROM servers WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1)`,
      )
      .get(profileName) as { nextSortOrder: number };
    try {
      this.db
        .query(
          `INSERT INTO servers (profile_id, name, sort_order, template, created_at)
           VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)`,
        )
        .run(profileName, name, row.nextSortOrder, template, createdAt);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`Server "${name}" already exists.`);
      }
      throw err;
    }
  }

  public renameServer(profileName: string, oldName: string, newName: string): boolean {
    const result = this.db
      .query(
        `UPDATE servers SET name = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2) AND name = ?3`,
      )
      .run(newName, profileName, oldName);
    return result.changes > 0;
  }

  public setServerUrl(profileName: string, name: string, template: string): boolean {
    const result = this.db
      .query(
        `UPDATE servers SET template = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2) AND name = ?3`,
      )
      .run(template, profileName, name);
    return result.changes > 0;
  }

  public removeServer(profileName: string, name: string): boolean {
    const result = this.db
      .query(
        `DELETE FROM servers
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1) AND name = ?2`,
      )
      .run(profileName, name);
    return result.changes > 0;
  }

  public reorderServers(profileName: string, names: string[]): void {
    const tx = this.db.transaction((pname: string, nameList: string[]) => {
      const update = this.db.query(
        `UPDATE servers SET sort_order = ?1
         WHERE profile_id = (SELECT id FROM profiles WHERE name = ?2) AND name = ?3`,
      );
      nameList.forEach((name, index) => {
        update.run(index, pname, name);
      });
    });
    tx(profileName, names);
  }

  // Import/export methods

  public replaceProfileFromFullDump(profileName: string, dump: ProfileDump): void {
    const tx = this.db.transaction((pname: string, d: ProfileDump) => {
      this.db
        .query("DELETE FROM users WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1)")
        .run(pname);
      this.db
        .query("DELETE FROM servers WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1)")
        .run(pname);

      const insertUser = this.db.query(
        `INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
         VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)`,
      );
      for (const user of d.USERS) {
        insertUser.run(pname, user.clientName, user.subscriptionToken, user.userUuid, user.createdAt);
      }

      const insertServer = this.db.query(
        `INSERT INTO servers (profile_id, name, sort_order, template, created_at)
         VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)`,
      );
      for (const server of d.SERVERS) {
        insertServer.run(pname, server.name, server.sortOrder, server.template, server.createdAt);
      }
    });
    tx(profileName, dump);
  }

  public mergeProfileFromFullDump(profileName: string, dump: ProfileDump): void {
    const tx = this.db.transaction((pname: string, d: ProfileDump) => {
      const upsertUser = this.db.query(`
        INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
        VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)
        ON CONFLICT(profile_id, client_name) DO UPDATE SET
          subscription_token = excluded.subscription_token,
          user_uuid = excluded.user_uuid,
          created_at = excluded.created_at
        WHERE excluded.created_at > users.created_at
      `);
      for (const user of d.USERS) {
        upsertUser.run(pname, user.clientName, user.subscriptionToken, user.userUuid, user.createdAt);
      }

      const upsertServer = this.db.query(`
        INSERT INTO servers (profile_id, name, sort_order, template, created_at)
        VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)
        ON CONFLICT(profile_id, name) DO UPDATE SET
          sort_order = excluded.sort_order,
          template = excluded.template,
          created_at = excluded.created_at
        WHERE excluded.created_at > servers.created_at
      `);
      for (const server of d.SERVERS) {
        upsertServer.run(pname, server.name, server.sortOrder, server.template, server.createdAt);
      }
    });
    tx(profileName, dump);
  }

  public mergeProfileFromLegacyConfig(profileName: string, config: LegacyConfig, subLinkSecret: string): void {
    const tx = this.db.transaction((pname: string, appConfig: LegacyConfig, secret: string) => {
      const now = Date.now();

      const insertUser = this.db.query(`
        INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
        VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)
        ON CONFLICT(profile_id, client_name) DO NOTHING
      `);
      for (const [clientName, userUuid] of Object.entries(appConfig.USERS) as [string, string][]) {
        insertUser.run(
          pname,
          clientName,
          createHmac("sha256", secret).update(`${pname}:${clientName}`).digest("base64url"),
          userUuid,
          now,
        );
      }

      const existingTemplates = new Set(
        (
          this.db
            .query(
              "SELECT s.template FROM servers s JOIN profiles p ON p.id = s.profile_id WHERE p.name = ?1",
            )
            .all(pname) as { template: string }[]
        ).map((r) => r.template),
      );
      const existingNames = new Set(
        (
          this.db
            .query(
              "SELECT s.name FROM servers s JOIN profiles p ON p.id = s.profile_id WHERE p.name = ?1",
            )
            .all(pname) as { name: string }[]
        ).map((r) => r.name),
      );

      const getNextSortOrder = this.db.query(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder FROM servers WHERE profile_id = (SELECT id FROM profiles WHERE name = ?1)",
      );
      const insertServer = this.db.query(
        `INSERT INTO servers (profile_id, name, sort_order, template, created_at)
         VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)`,
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
        const row = getNextSortOrder.get(pname) as { nextSortOrder: number };
        insertServer.run(pname, name, row.nextSortOrder, template, now);
        existingNames.add(name);
        existingTemplates.add(template);
      }
    });
    tx(profileName, config, subLinkSecret);
  }

  public mergeAllFromMultiProfileDump(dump: MultiProfileDump): void {
    const tx = this.db.transaction((d: MultiProfileDump) => {
      const now = Date.now();

      const ensureProfile = this.db.query(`
        INSERT INTO profiles (name, created_at)
        VALUES (?1, ?2)
        ON CONFLICT(name) DO NOTHING
      `);
      const upsertUser = this.db.query(`
        INSERT INTO users (profile_id, client_name, subscription_token, user_uuid, created_at)
        VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)
        ON CONFLICT(profile_id, client_name) DO UPDATE SET
          subscription_token = excluded.subscription_token,
          user_uuid = excluded.user_uuid,
          created_at = excluded.created_at
        WHERE excluded.created_at > users.created_at
      `);
      const upsertServer = this.db.query(`
        INSERT INTO servers (profile_id, name, sort_order, template, created_at)
        VALUES ((SELECT id FROM profiles WHERE name = ?1), ?2, ?3, ?4, ?5)
        ON CONFLICT(profile_id, name) DO UPDATE SET
          sort_order = excluded.sort_order,
          template = excluded.template,
          created_at = excluded.created_at
        WHERE excluded.created_at > servers.created_at
      `);

      for (const [profileName, profileData] of Object.entries(d.profiles)) {
        ensureProfile.run(profileName, now);

        for (const user of profileData.USERS) {
          upsertUser.run(profileName, user.clientName, user.subscriptionToken, user.userUuid, user.createdAt);
        }
        for (const server of profileData.SERVERS) {
          upsertServer.run(profileName, server.name, server.sortOrder, server.template, server.createdAt);
        }
      }
    });
    tx(dump);
  }

  public close(): void {
    this.db.close();
  }
}

export function buildProfileDump(storage: Storage, profileName: string): ProfileDump {
  return {
    USERS: storage.listUsers(profileName).map(({ clientName, userUuid, subscriptionToken, createdAt }) => ({
      clientName,
      userUuid,
      subscriptionToken,
      createdAt,
    })),
    SERVERS: storage.listServerRecords(profileName).map(({ name, sortOrder, template, createdAt }) => ({
      name,
      sortOrder,
      template,
      createdAt,
    })),
  };
}

export function buildMultiProfileDump(storage: Storage): MultiProfileDump {
  const profiles = storage.listProfiles();
  const result: MultiProfileDump = { profiles: {} };
  for (const profile of profiles) {
    result.profiles[profile.name] = buildProfileDump(storage, profile.name);
  }
  return result;
}
