import type { API } from "@ucanto/core";

export type ResourceId = `urn:capvine:resource:${string}`;
export type Identity = API.Signer;
export type Principal = API.Principal;
export type Grant = API.Delegation;
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export interface Resource {
  id: ResourceId;
  ownerId: string;
  kind: string;
  target: Record<string, string>;
}

export interface Task {
  id: string;
  ownerId: string;
  active: boolean;
}

export interface GrantRecord {
  id: string;
  taskId: string;
  resourceId: ResourceId;
  audience: string;
  expiresAt: number;
  action?: string;
  service?: string;
}

export interface AuditEvent {
  id: string;
  at: number;
  invocationId: string | null;
  outcome: "allowed" | "denied" | "failed";
  reason: string;
  rootGrantId?: string;
}

export interface StateStore {
  addResource(resource: Resource): void;
  getResource(id: string): Resource | undefined;
  addTask(task: Task): void;
  getTask(id: string): Task | undefined;
  endTask(id: string): void;
  addGrant(grant: GrantRecord): void;
  getGrant(id: string): GrantRecord | undefined;
  revoke(id: string): void;
  isRevoked(id: string): boolean;
  appendAudit(event: AuditEvent): void;
}

export interface Operation {
  action: string;
  resourceKind: string;
  execute(resource: Readonly<Resource>): Promise<Json>;
}

export interface GrantDecision {
  actor: string;
  task: Readonly<Task>;
  resource: Readonly<Resource>;
  action: string;
}

export class PermissionDenied extends Error {
  override name = "PermissionDenied";
}
