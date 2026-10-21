import type { AuditEvent, GrantRecord, Resource, Task } from "./types.ts";
import type { ApprovalStore, WorkflowApproval } from "./approvals.ts";

export class MemoryStore implements ApprovalStore {
  #approvals = new Map<string, WorkflowApproval>();
  #resources = new Map<string, Resource>();
  #tasks = new Map<string, Task>();
  #grants = new Map<string, GrantRecord>();
  #revocations = new Set<string>();
  #events: AuditEvent[] = [];

  addApproval(approval: WorkflowApproval): void {
    if (this.#approvals.has(approval.id) || this.#tasks.has(approval.taskId))
      throw new Error("Approval or task already exists");
    const record = structuredClone(approval);
    this.#approvals.set(record.id, record);
    this.#tasks.set(record.taskId, {
      id: record.taskId,
      ownerId: record.ownerId,
      active: true,
    });
  }

  getApproval(id: string): WorkflowApproval | undefined {
    return structuredClone(this.#approvals.get(id));
  }

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
