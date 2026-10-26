import type { AuditEvent, GrantRecord, Resource, Task } from "./types.ts";
import type { WorkflowApproval } from "./approvals.ts";
import type { InspectionStore, AuditPosition } from "./inspection.ts";

export class MemoryStore implements InspectionStore {
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

  listApprovals(
    ownerId: string,
    after: string,
    limit: number,
  ): WorkflowApproval[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
      throw new Error("Invalid approval limit");
    return structuredClone(
      [...this.#approvals.values()]
        .filter((row) => row.ownerId === ownerId && row.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit),
    );
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

  #ownsGrant(ownerId: string, grant: GrantRecord): boolean {
    return (
      this.#resources.get(grant.resourceId)?.ownerId === ownerId &&
      this.#tasks.get(grant.taskId)?.ownerId === ownerId
    );
  }

  listGrants(ownerId: string, after: string, limit: number): GrantRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
      throw new Error("Invalid inspection limit");
    return structuredClone(
      [...this.#grants.values()]
        .filter((row) => row.id > after && this.#ownsGrant(ownerId, row))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit),
    );
  }

  listAudit(
    ownerId: string,
    after: AuditPosition | undefined,
    limit: number,
  ): AuditEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
      throw new Error("Invalid inspection limit");
    return structuredClone(
      this.#events
        .filter((row) => {
          const grant = this.#grants.get(row.rootGrantId ?? "");
          return (
            grant &&
            this.#ownsGrant(ownerId, grant) &&
            (!after ||
              row.at > after.at ||
              (row.at === after.at && row.id > after.id))
          );
        })
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit),
    );
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
