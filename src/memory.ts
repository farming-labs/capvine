import type {
  AuditEvent,
  GrantRecord,
  Resource,
  StateStore,
  Task,
} from "./types.ts";

export class MemoryStore implements StateStore {
  #resources = new Map<string, Resource>();
  #tasks = new Map<string, Task>();
  #grants = new Map<string, GrantRecord>();
  #revocations = new Set<string>();
  #events: AuditEvent[] = [];

  addResource(resource: Resource): void {
    if (this.#resources.has(resource.id))
      throw new Error("Resource already exists");
    this.#resources.set(resource.id, structuredClone(resource));
  }

  getResource(id: string): Resource | undefined {
    return structuredClone(this.#resources.get(id));
  }

  addTask(task: Task): void {
    if (this.#tasks.has(task.id)) throw new Error("Task already exists");
    this.#tasks.set(task.id, structuredClone(task));
  }

  getTask(id: string): Task | undefined {
    return structuredClone(this.#tasks.get(id));
  }

  endTask(id: string): void {
    const task = this.#tasks.get(id);
    if (!task) throw new Error("Unknown task");
    task.active = false;
  }

  addGrant(grant: GrantRecord): void {
    if (this.#grants.has(grant.id)) throw new Error("Grant already exists");
    this.#grants.set(grant.id, structuredClone(grant));
  }

  getGrant(id: string): GrantRecord | undefined {
    return structuredClone(this.#grants.get(id));
  }

  revoke(id: string): void {
    this.#revocations.add(id);
  }

  isRevoked(id: string): boolean {
    return this.#revocations.has(id);
  }

  appendAudit(event: AuditEvent): void {
    this.#events.push(structuredClone(event));
  }

  audit(): AuditEvent[] {
    return structuredClone(this.#events);
  }
}
