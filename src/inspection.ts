import type { ApprovalStore } from "./approvals.ts";
import {
  PermissionDenied,
  type AuditEvent,
  type GrantRecord,
  type ResourceId,
} from "./types.ts";

export interface InspectionQuery {
  after?: string;
  limit?: number;
}

export interface AuditPosition {
  at: number;
  id: string;
}

export interface InspectionStore extends ApprovalStore {
  listGrants(ownerId: string, after: string, limit: number): GrantRecord[];
  listAudit(
    ownerId: string,
    after: AuditPosition | undefined,
    limit: number,
  ): AuditEvent[];
}

export type InspectedGrant = {
  id: string;
  audience: string;
  resource: ResourceId;
  action: string | null;
  service: string | null;
  task: { id: string; active: boolean };
  expiresAt: number;
  expired: boolean;
  revoked: boolean;
  workflow: {
    id: string;
    expiresAt: number;
    expired: boolean;
    disabled: boolean;
  } | null;
};

export type InspectedOutcome = {
  id: string;
  at: number;
  invocationId: string | null;
  rootGrantId: string;
  outcome: AuditEvent["outcome"];
  reason: "authorized" | "authorization_failed" | "handler_failed" | "other";
};

export type GrantPage = {
  grants: InspectedGrant[];
  nextCursor: string | null;
};

export type AuditPage = {
  events: InspectedOutcome[];
  nextCursor: string | null;
};

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function validId(value: unknown): value is string {
  return text(value) && /^[A-Za-z0-9._:-]+$/.test(value);
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function state(valid: unknown): asserts valid {
  if (!valid) throw new Error("Invalid inspection state");
}

function query(input: InspectionQuery) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "after" && key !== "limit")
  )
    throw new PermissionDenied("Invalid inspection query");
  const after = input.after === undefined ? "" : input.after;
  const limit = input.limit === undefined ? 25 : input.limit;
  if (
    typeof after !== "string" ||
    after.length > 1024 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new PermissionDenied("Invalid inspection query");
  return { after, limit };
}

function cursor(position: AuditPosition): string {
  return Buffer.from(JSON.stringify([position.at, position.id])).toString(
    "base64url",
  );
}

function position(value: string): AuditPosition | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      timestamp(parsed[0]) &&
      validId(parsed[1])
    ) {
      const result = { at: parsed[0], id: parsed[1] };
      if (cursor(result) === value) return result;
    }
  } catch {}
  throw new PermissionDenied("Invalid audit cursor");
}

export function createPermissionInspector(options: {
  store: InspectionStore;
  owner: string;
}) {
  const { store, owner } = options;
  if (!text(owner)) throw new Error("Owner is required");

  function owned(id: string) {
    if (!validId(id)) throw new PermissionDenied("Invalid grant reference");
    const grant = store.getGrant(id);
    if (!grant) throw new PermissionDenied("Unknown owned root grant");
    state(grant.id === id && text(grant.resourceId) && text(grant.taskId));
    const resource = store.getResource(grant.resourceId);
    const task = store.getTask(grant.taskId);
    if (
      !resource ||
      !task ||
      resource.ownerId !== owner ||
      task.ownerId !== owner
    )
      throw new PermissionDenied("Unknown owned root grant");
    state(
      resource.id === grant.resourceId &&
        task.id === grant.taskId &&
        typeof task.active === "boolean",
    );
    return { grant, task };
  }

  function inspect(id: string, now: number): InspectedGrant {
    const { grant, task } = owned(id);
    state(
      text(grant.audience) &&
        timestamp(grant.expiresAt) &&
        (grant.action === undefined || text(grant.action)) &&
        (grant.service === undefined || text(grant.service)),
    );
    const approval = task.id.startsWith("approval:")
      ? store.getApproval(task.id.slice(9))
      : undefined;
    if (approval)
      state(
        approval.ownerId === owner &&
          approval.taskId === task.id &&
          text(approval.id) &&
          timestamp(approval.expiresAt),
      );
    const revoked = store.isRevoked(id);
    state(typeof revoked === "boolean");
    return {
      id,
      audience: grant.audience,
      resource: grant.resourceId,
      action: grant.action ?? null,
      service: grant.service ?? null,
      task: { id: task.id, active: task.active },
      expiresAt: grant.expiresAt,
      expired: grant.expiresAt <= now,
      revoked,
      workflow: approval
        ? {
            id: approval.id,
            expiresAt: approval.expiresAt,
            expired: approval.expiresAt <= now,
            disabled: !task.active,
          }
        : null,
    };
  }

  return {
    grants: {
      get(id: string): InspectedGrant {
        return inspect(id, Math.floor(Date.now() / 1000));
      },
      list(input: InspectionQuery = {}): GrantPage {
        const { after, limit } = query(input);
        if (after && !validId(after))
          throw new PermissionDenied("Invalid grant cursor");
        const rows = store.listGrants(owner, after, limit + 1);
        state(Array.isArray(rows) && rows.length <= limit + 1);
        let previous = after;
        const now = Math.floor(Date.now() / 1000);
        const grants = rows.map((row) => {
          state(row && validId(row.id) && row.id > previous);
          previous = row.id;
          return inspect(row.id, now);
        });
        return {
          grants: grants.slice(0, limit),
          nextCursor: grants.length > limit ? grants[limit - 1]!.id : null,
        };
      },
    },
    audit: {
      list(input: InspectionQuery = {}): AuditPage {
        const { after, limit } = query(input);
        let previous = position(after);
        const rows = store.listAudit(owner, previous, limit + 1);
        state(Array.isArray(rows) && rows.length <= limit + 1);
        const events = rows.map((row): InspectedOutcome => {
          state(
            row &&
              validId(row.id) &&
              timestamp(row.at) &&
              (row.invocationId === null || validId(row.invocationId)) &&
              text(row.rootGrantId) &&
              ["allowed", "denied", "failed"].includes(row.outcome),
          );
          state(
            !previous ||
              row.at > previous.at ||
              (row.at === previous.at && row.id > previous.id),
          );
          previous = { at: row.at, id: row.id };
          owned(row.rootGrantId);
          const reason =
            row.reason === "authorized" ||
            row.reason === "authorization_failed" ||
            row.reason === "handler_failed"
              ? row.reason
              : "other";
          return {
            id: row.id,
            at: row.at,
            invocationId: row.invocationId,
            rootGrantId: row.rootGrantId,
            outcome: row.outcome,
            reason,
          };
        });
        return {
          events: events.slice(0, limit),
          nextCursor: events.length > limit ? cursor(events[limit - 1]!) : null,
        };
      },
    },
  };
}
