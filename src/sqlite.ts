import { DatabaseSync } from "node:sqlite";
import type {
  AuditEvent,
  GrantRecord,
  Resource,
  StateStore,
  Task,
} from "./types.ts";

export class SqliteStore implements StateStore {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    try {
      const version = Number(
        this.#db.prepare("PRAGMA user_version").get()!.user_version,
      );
      if (![0, 1].includes(version))
        throw new Error("Unsupported state schema version");
      const tables = this.#db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      const expected = [
        "capvine_audit",
        "capvine_records",
        "capvine_revocations",
      ];
      if (version === 1) expected.splice(1, 0, "capvine_metadata");
      if (
        !(version === 0 && tables.length === 0) &&
        JSON.stringify(tables) !== JSON.stringify(expected)
      )
        throw new Error("Unrecognized state schema");
      this.#db.exec("BEGIN IMMEDIATE");
      this.#db.exec(`
      CREATE TABLE IF NOT EXISTS capvine_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS capvine_revocations (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS capvine_audit (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capvine_metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
      this.#db.exec("COMMIT");
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      this.#db.close();
      throw error;
    }
  }

  bindService(authority: string, owner: string): void {
    const expected = JSON.stringify({ authority, owner });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#db
        .prepare("SELECT value FROM capvine_metadata WHERE id = 'service'")
        .get();
      if (current) {
        if (current.value !== expected)
          throw new Error("State belongs to another authority or owner");
      } else {
        const count = Number(
          this.#db
            .prepare("SELECT count(*) AS count FROM capvine_records")
            .get()!.count,
        );
        if (count !== 0)
          throw new Error(
            "Existing unbound state requires an explicit migration review",
          );
        this.#db
          .prepare("INSERT INTO capvine_metadata VALUES ('service', ?)")
          .run(expected);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #add(kind: string, id: string, value: unknown): void {
    this.#db
      .prepare("INSERT INTO capvine_records (kind, id, value) VALUES (?, ?, ?)")
      .run(kind, id, JSON.stringify(value));
  }

  #get<T>(kind: string, id: string): T | undefined {
    const row = this.#db
      .prepare("SELECT value FROM capvine_records WHERE kind = ? AND id = ?")
      .get(kind, id);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }

  addResource(resource: Resource): void {
    this.#add("resource", resource.id, resource);
  }
  getResource(id: string): Resource | undefined {
    return this.#get("resource", id);
  }
  addTask(task: Task): void {
    this.#add("task", task.id, task);
  }
  getTask(id: string): Task | undefined {
    return this.#get("task", id);
  }
  addGrant(grant: GrantRecord): void {
    this.#add("grant", grant.id, grant);
  }
  getGrant(id: string): GrantRecord | undefined {
    return this.#get("grant", id);
  }

  endTask(id: string): void {
    const task = this.getTask(id);
    if (!task) throw new Error("Unknown task");
    this.#db
      .prepare(
        "UPDATE capvine_records SET value = ? WHERE kind = 'task' AND id = ?",
      )
      .run(JSON.stringify({ ...task, active: false }), id);
  }

  revoke(id: string): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO capvine_revocations (id) VALUES (?)")
      .run(id);
  }

  isRevoked(id: string): boolean {
    return (
      this.#db
        .prepare("SELECT id FROM capvine_revocations WHERE id = ?")
        .get(id) !== undefined
    );
  }

  appendAudit(event: AuditEvent): void {
    this.#db
      .prepare("INSERT INTO capvine_audit (id, value) VALUES (?, ?)")
      .run(event.id, JSON.stringify(event));
  }

  audit(limit = 1000): AuditEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error("Invalid audit limit");
    return this.#db
      .prepare(
        "SELECT value FROM (SELECT rowid, value FROM capvine_audit ORDER BY rowid DESC LIMIT ?) ORDER BY rowid",
      )
      .all(limit)
      .map((row) => JSON.parse(String(row.value)) as AuditEvent);
  }

  close(): void {
    this.#db.close();
  }
}
