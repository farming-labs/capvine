import { DatabaseSync } from "node:sqlite";
import type { WorkflowApproval } from "./approvals.ts";
import type { AuditEvent, GrantRecord, Resource, Task } from "./types.ts";
import type { InspectionStore, AuditPosition } from "./inspection.ts";

export class SqliteStore implements InspectionStore {
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

  addApproval(approval: WorkflowApproval): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#add("approval", approval.id, approval);
      this.addTask({
        id: approval.taskId,
        ownerId: approval.ownerId,
        active: true,
      });
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getApproval(id: string): WorkflowApproval | undefined {
    return this.#get("approval", id);
  }

  listApprovals(
    ownerId: string,
    after: string,
    limit: number,
  ): WorkflowApproval[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
      throw new Error("Invalid approval limit");
    return this.#db
      .prepare(
        "SELECT value FROM capvine_records WHERE kind = 'approval' AND id > ? AND json_extract(value, '$.ownerId') = ? ORDER BY id LIMIT ?",
      )
      .all(after, ownerId, limit)
      .map((row) => JSON.parse(String(row.value)) as WorkflowApproval);
  }

  addResource(resource: Resource): void {
    this.#add("resource", resource.id, resource);
  }
  getResource(id: string): Resource | undefined {
    return this.#get("resource", id);
  }
  registerResource(resource: Resource, registration: unknown): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.addResource(resource);
      this.#add("registration", resource.id, registration);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  bindApplication(origin: string, ownerId: string): void {
    const binding = JSON.stringify({ version: 1, origin, ownerId });
    const row = this.#db
      .prepare("SELECT value FROM capvine_metadata WHERE id = 'application'")
      .get();
    if (row) {
      if (row.value !== binding)
        throw new Error("Application belongs to another origin or owner");
      return;
    }
    const count = this.#db
      .prepare(
        "SELECT count(*) AS count FROM capvine_records WHERE kind = 'registration'",
      )
      .get();
    if (Number(count!.count) !== 0)
      throw new Error("Existing registrations require an application binding");
    this.#db
      .prepare("INSERT INTO capvine_metadata VALUES ('application', ?)")
      .run(binding);
  }
  registrations(): unknown[] {
    return this.#db
      .prepare(
        "SELECT value FROM capvine_records WHERE kind = 'registration' ORDER BY id LIMIT 257",
      )
      .all()
      .map((row) => JSON.parse(String(row.value)) as unknown);
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

  listGrants(ownerId: string, after: string, limit: number): GrantRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
      throw new Error("Invalid inspection limit");
    return this.#db
      .prepare(
        `
      SELECT g.value FROM capvine_records g
      JOIN capvine_records r ON r.kind = 'resource' AND r.id = json_extract(g.value, '$.resourceId')
      JOIN capvine_records t ON t.kind = 'task' AND t.id = json_extract(g.value, '$.taskId')
      WHERE g.kind = 'grant' AND g.id > ?
        AND json_extract(r.value, '$.ownerId') = ? AND json_extract(t.value, '$.ownerId') = ?
      ORDER BY g.id LIMIT ?
    `,
      )
      .all(after, ownerId, ownerId, limit)
      .map((row) => JSON.parse(String(row.value)) as GrantRecord);
  }

  listAudit(
    ownerId: string,
    after: AuditPosition | undefined,
    limit: number,
  ): AuditEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
      throw new Error("Invalid inspection limit");
    return this.#db
      .prepare(
        `
      SELECT a.value FROM capvine_audit a
      JOIN capvine_records g ON g.kind = 'grant' AND g.id = json_extract(a.value, '$.rootGrantId')
      JOIN capvine_records r ON r.kind = 'resource' AND r.id = json_extract(g.value, '$.resourceId')
      JOIN capvine_records t ON t.kind = 'task' AND t.id = json_extract(g.value, '$.taskId')
      WHERE json_extract(r.value, '$.ownerId') = ? AND json_extract(t.value, '$.ownerId') = ?
        AND (json_extract(a.value, '$.at') > ? OR (json_extract(a.value, '$.at') = ? AND a.id > ?))
      ORDER BY json_extract(a.value, '$.at'), a.id LIMIT ?
    `,
      )
      .all(
        ownerId,
        ownerId,
        after?.at ?? -1,
        after?.at ?? -1,
        after?.id ?? "",
        limit,
      )
      .map((row) => JSON.parse(String(row.value)) as AuditEvent);
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
