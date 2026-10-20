import { delegate } from "@ucanto/client";
import { access, Authorization, DID, Revoked } from "@ucanto/validator";
import { Verifier } from "@ucanto/principal";
import {
  asInvocation,
  decodeGrant,
  expiry,
  inspectChain,
  operationCapability,
  readClaim,
} from "./profile.ts";
import {
  PermissionDenied,
  type AuditEvent,
  type Grant,
  type GrantDecision,
  type Identity,
  type Json,
  type Operation,
  type Principal,
  type ResourceId,
  type StateStore,
} from "./types.ts";

export function createAuthority(options: {
  signer: Identity;
  store: StateStore;
  authorizeGrant: (request: GrantDecision) => boolean | Promise<boolean>;
}) {
  const operations = new Map<string, Operation>();
  const service = DID.match({ method: "key" }).from(options.signer.did());

  function audit(
    invocationId: string | null,
    outcome: AuditEvent["outcome"],
    reason: string,
  ) {
    options.store.appendAudit({
      id: crypto.randomUUID(),
      at: Date.now(),
      invocationId,
      outcome,
      reason,
    });
  }

  return {
    principal: { did: () => options.signer.did() },

    registerOperation(operation: Operation): void {
      if (operations.has(operation.action))
        throw new Error("Operation already exists");
      operations.set(operation.action, { ...operation });
    },

    async issue(input: {
      actor: string;
      audience: Principal;
      taskId: string;
      resource: ResourceId;
      action: string;
      expiresAt: Date;
    }): Promise<Grant> {
      const action = input.action;
      const audienceId = DID.match({ method: "key" }).from(
        input.audience.did(),
      );
      const audience = { did: () => audienceId };
      const resource = options.store.getResource(input.resource);
      const task = options.store.getTask(input.taskId);
      const operation = operations.get(action);
      const expiration = expiry(input.expiresAt);
      if (
        !resource ||
        !task?.active ||
        resource.ownerId !== task.ownerId ||
        operation?.resourceKind !== resource.kind
      ) {
        throw new PermissionDenied(
          "Resource, task, or operation is unavailable",
        );
      }
      const decision = structuredClone({
        actor: input.actor,
        task,
        resource,
        action,
      });
      if (!(await options.authorizeGrant(decision)))
        throw new PermissionDenied("Owner policy denied the grant");
      if (!options.store.getTask(task.id)?.active)
        throw new PermissionDenied("Task has ended");
      const grant = await delegate({
        issuer: options.signer,
        audience,
        capabilities: [
          operationCapability.create({
            with: resource.id,
            nb: { action, task: task.id, service },
          }),
        ],
        expiration,
        nonce: crypto.randomUUID(),
      });
      options.store.addGrant({
        id: grant.cid.toString(),
        taskId: task.id,
        resourceId: resource.id,
        audience: audienceId,
        expiresAt: expiration,
      });
      return grant;
    },

    async execute(bytes: Uint8Array): Promise<Json> {
      let invocationId: string | null = null;
      let dispatched = false;
      try {
        const invocation = await decodeGrant(bytes);
        invocationId = invocation.cid.toString();
        const chain = inspectChain(invocation);
        const claim = readClaim(invocation);
        if (
          chain.length < 2 ||
          invocation.audience.did() !== options.signer.did() ||
          claim.service !== options.signer.did()
        ) {
          throw new PermissionDenied(
            "Wrong service or missing delegation proof",
          );
        }
        const root = chain.at(-1)!;
        if (
          root.issuer.did() !== options.signer.did() ||
          !options.store.getGrant(root.cid.toString())
        ) {
          throw new PermissionDenied("Unknown root grant");
        }
        const authorization = await access(asInvocation(invocation), {
          capability: operationCapability,
          authority: options.signer,
          principal: Verifier,
          canIssue: (_capability, issuer) => issuer === options.signer.did(),
          validateAuthorization: (authorized) => {
            for (const link of Authorization.iterate(authorized)) {
              if (options.store.isRevoked(link.toString()))
                return { error: new Revoked(authorized.delegation) };
            }
            return { ok: {} };
          },
        });
        if (authorization.error)
          throw new PermissionDenied("Invalid, expired, or revoked delegation");
        const task = options.store.getTask(claim.task);
        const resource = options.store.getResource(claim.resource);
        const operation = operations.get(claim.action);
        if (
          !task?.active ||
          !resource ||
          resource.ownerId !== task.ownerId ||
          operation?.resourceKind !== resource.kind
        ) {
          throw new PermissionDenied(
            "Resource, task, or operation is unavailable",
          );
        }
        if (
          chain.some((proof) => options.store.isRevoked(proof.cid.toString()))
        ) {
          throw new PermissionDenied("Grant has been revoked");
        }
        audit(invocationId, "allowed", "authorized");
        dispatched = true;
        return await operation.execute(resource);
      } catch (error) {
        audit(
          invocationId,
          dispatched ? "failed" : "denied",
          dispatched ? "handler_failed" : "authorization_failed",
        );
        throw error;
      }
    },
  };
}
