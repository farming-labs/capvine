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
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS capvine_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS capvine_revocations (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS capvine_audit (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
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

  audit(): AuditEvent[] {
    return this.#db
      .prepare("SELECT value FROM capvine_audit ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.value)) as AuditEvent);
  }

  close(): void {
    this.#db.close();
  }
}
