import { ed25519 } from "@ucanto/principal";
import { expiry } from "./profile.ts";
import type { createAuthority } from "./server.ts";
import {
  PermissionDenied,
  type Principal,
  type ResourceId,
  type StateStore,
} from "./types.ts";

export interface WorkflowApproval {
  id: string;
  ownerId: string;
  audience: string;
  resource: ResourceId;
  action: string;
  expiresAt: number;
  maxGrantSeconds: number;
  taskId: string;
}

export interface ApprovalStore extends StateStore {
  /** Atomically insert the approval and its new active task; reject duplicates. */
  addApproval(approval: WorkflowApproval): void;
  getApproval(id: string): WorkflowApproval | undefined;
  listApprovals?(
    ownerId: string,
    after: string,
    limit: number,
  ): WorkflowApproval[];
}

export interface WorkflowApprovalInput {
  id: string;
  audience: Principal;
  resource: ResourceId;
  action: string;
  expiresAt: Date;
  maxGrantSeconds: number;
}

export function createWorkflowApprovals(options: {
  authority: ReturnType<typeof createAuthority>;
  store: ApprovalStore;
  owner: string;
}) {
  function owned(id: string): WorkflowApproval {
    const approval = options.store.getApproval(id);
    if (
      !approval ||
      approval.ownerId !== options.owner ||
      options.store.getResource(approval.resource)?.ownerId !== options.owner ||
      options.store.getTask(approval.taskId)?.ownerId !== options.owner
    )
      throw new PermissionDenied("Unknown owned approval");
    return approval;
  }

  return {
    list(input: { after?: string; limit?: number } = {}) {
      const after = input.after ?? "";
      const limit = input.limit ?? 20;
      if (
        (after && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(after)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !options.store.listApprovals
      )
        throw new PermissionDenied("Invalid or unsupported approval listing");
      const rows = options.store.listApprovals(options.owner, after, limit + 1);
      const approvals = rows.slice(0, limit).map((row) => {
        const approval = owned(row.id);
        return {
          ...approval,
          active:
            options.store.getTask(approval.taskId)?.active === true &&
            approval.expiresAt > Math.floor(Date.now() / 1000),
        };
      });
      return {
        approvals,
        nextCursor: rows.length > limit ? approvals.at(-1)!.id : null,
      };
    },
    approve(input: WorkflowApprovalInput): WorkflowApproval {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.id) ||
        !input.resource.startsWith("urn:capvine:resource:") ||
        input.action.length === 0 ||
        input.action.length > 1024 ||
        !Number.isSafeInteger(input.maxGrantSeconds) ||
        input.maxGrantSeconds < 1 ||
        input.maxGrantSeconds > 3600 ||
        options.store.getResource(input.resource)?.ownerId !== options.owner
      )
        throw new PermissionDenied("Invalid workflow approval");
      const audience = ed25519.Verifier.parse(
        input.audience.did() as `did:key:${string}`,
      );
      const approval: WorkflowApproval = {
        id: input.id,
        ownerId: options.owner,
        audience: audience.did(),
        resource: input.resource,
        action: input.action,
        expiresAt: expiry(input.expiresAt),
        maxGrantSeconds: input.maxGrantSeconds,
        taskId: `approval:${input.id}`,
      };
      options.store.addApproval(approval);
      return structuredClone(approval);
    },

    read(id: string) {
      const approval = owned(id);
      return {
        ...approval,
        active:
          options.store.getTask(approval.taskId)?.active === true &&
          approval.expiresAt > Math.floor(Date.now() / 1000),
      };
    },

    async issue(id: string) {
      const approval = owned(id);
      if (!options.store.getTask(approval.taskId)?.active)
        throw new PermissionDenied("Approval is disabled");
      return options.authority.issue({
        actor: options.owner,
        audience: ed25519.Verifier.parse(
          approval.audience as `did:key:${string}`,
        ),
        taskId: approval.taskId,
        resource: approval.resource,
        action: approval.action,
        expiresAt: new Date(
          Math.min(
            approval.expiresAt,
            Math.floor(Date.now() / 1000) + approval.maxGrantSeconds,
          ) * 1000,
        ),
      });
    },

    disable(id: string): void {
      options.store.endTask(owned(id).taskId);
    },
  };
}
