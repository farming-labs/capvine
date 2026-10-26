import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ed25519 } from "@ucanto/principal";
import { encodeGrant, decodeGrant } from "./profile.ts";
import {
  PermissionDenied,
  type Grant,
  type Json,
  type Principal,
  type ResourceId,
  type StateStore,
  type AuditEvent,
} from "./types.ts";
import {
  readRequest,
  readResponse,
  respond,
  RequestError,
} from "./http-internal.ts";
import type { createAuthority } from "./server.ts";
import type {
  createPermissionInspector,
  InspectionQuery,
  GrantPage,
  AuditPage,
  InspectedGrant,
} from "./inspection.ts";
import type {
  createWorkflowApprovals,
  WorkflowApprovalInput,
} from "./approvals.ts";

function fields(value: unknown, required: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Invalid command");
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== required.length ||
    required.some((key) => !Object.hasOwn(result, key))
  )
    throw new RequestError(400, "Invalid command fields");
  return result;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024)
    throw new RequestError(400, "Invalid string");
  return value;
}

function recipient(value: unknown): Principal {
  try {
    return ed25519.Verifier.parse(string(value) as `did:key:${string}`);
  } catch {
    throw new RequestError(400, "Invalid recipient");
  }
}

async function grantResponse(grant: Grant): Promise<Json> {
  return {
    grant: Buffer.from(await encodeGrant(grant)).toString("base64"),
    id: grant.cid.toString(),
  };
}

function parseGrantResponse(value: Json): Promise<Grant> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.grant !== "string"
  )
    throw new Error("Invalid grant response");
  return decodeGrant(Buffer.from(value.grant, "base64"));
}

export function validateAdminToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error(
      "Use a randomly generated 32-byte base64url administration token",
    );
}

export function createAdministrationHandler(options: {
  authority: ReturnType<typeof createAuthority>;
  store: StateStore;
  owner: string;
  token: string;
  audit: () => AuditEvent[];
  approvals?: ReturnType<typeof createWorkflowApprovals>;
  inspection?: ReturnType<typeof createPermissionInspector>;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  validateAdminToken(options.token);
  const expected = createHash("sha256")
    .update(`Bearer ${options.token}`)
    .digest();
  let active = 0;
  return async (request, response) => {
    if (request.url !== "/admin" || request.method !== "POST") {
      request.resume();
      respond(response, 404, { error: "not_found" });
      return;
    }
    const actual = createHash("sha256")
      .update(request.headers.authorization ?? "")
      .digest();
    if (!timingSafeEqual(expected, actual)) {
      request.resume();
      respond(response, 401, { error: "unauthorized" });
      return;
    }
    if (
      request.headers.origin ||
      request.headers["content-type"] !== "application/json"
    ) {
      request.resume();
      respond(response, 400, { error: "invalid_request" });
      return;
    }
    if (active >= 4) {
      request.resume();
      respond(response, 429, { error: "busy" });
      return;
    }
    active++;
    try {
      let input: unknown;
      try {
        input = JSON.parse(
          Buffer.from(await readRequest(request)).toString("utf8"),
        );
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(400, "Invalid JSON");
      }
      const command = fields(input, ["method", "params"]);
      let result: Json;
      switch (command.method) {
        case "grant.list":
        case "audit.list": {
          if (!options.inspection)
            throw new RequestError(400, "Inspection is unavailable");
          const p = fields(command.params, ["after", "limit"]);
          if (typeof p.after !== "string" || typeof p.limit !== "number")
            throw new RequestError(400, "Invalid inspection query");
          const input = { after: p.after, limit: p.limit };
          result =
            command.method === "grant.list"
              ? options.inspection.grants.list(input)
              : options.inspection.audit.list(input);
          break;
        }
        case "grant.read": {
          if (!options.inspection)
            throw new RequestError(400, "Inspection is unavailable");
          const p = fields(command.params, ["id"]);
          result = options.inspection.grants.get(string(p.id));
          break;
        }
        case "task.create": {
          const p = fields(command.params, ["id"]);
          const id = string(p.id);
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
            throw new RequestError(400, "Invalid task ID");
          if (options.store.getTask(id))
            throw new RequestError(409, "Task exists");
          options.store.addTask({ id, ownerId: options.owner, active: true });
          result = { id };
          break;
        }
        case "grant.issue": {
          const p = fields(command.params, [
            "audience",
            "taskId",
            "resource",
            "action",
            "expiresAt",
          ]);
          const expiresAt = new Date(string(p.expiresAt));
          if (
            !Number.isFinite(expiresAt.getTime()) ||
            expiresAt.getTime() > Date.now() + 3_600_000
          )
            throw new RequestError(400, "Invalid grant lifetime");
          const grant = await options.authority.issue({
            actor: options.owner,
            audience: recipient(p.audience),
            taskId: string(p.taskId),
            resource: string(p.resource) as ResourceId,
            action: string(p.action),
            expiresAt,
          });
          result = await grantResponse(grant);
          break;
        }
        case "approval.list": {
          if (!options.approvals)
            throw new RequestError(400, "Approvals are unavailable");
          const p = fields(command.params, ["after", "limit"]);
          if (typeof p.after !== "string" || typeof p.limit !== "number")
            throw new RequestError(400, "Invalid listing");
          result = options.approvals.list({ after: p.after, limit: p.limit });
          break;
        }
        case "approval.create": {
          if (!options.approvals)
            throw new RequestError(400, "Approvals are unavailable");
          const p = fields(command.params, [
            "id",
            "audience",
            "resource",
            "action",
            "expiresAt",
            "maxGrantSeconds",
          ]);
          if (typeof p.maxGrantSeconds !== "number")
            throw new RequestError(400, "Invalid grant lifetime");
          result = {
            ...options.approvals.approve({
              id: string(p.id),
              audience: recipient(p.audience),
              resource: string(p.resource) as ResourceId,
              action: string(p.action),
              expiresAt: new Date(string(p.expiresAt)),
              maxGrantSeconds: p.maxGrantSeconds,
            }),
          };
          break;
        }
        case "approval.issue":
        case "approval.read":
        case "approval.disable": {
          if (!options.approvals)
            throw new RequestError(400, "Approvals are unavailable");
          const p = fields(command.params, ["id"]);
          const id = string(p.id);
          if (command.method === "approval.issue")
            result = await grantResponse(await options.approvals.issue(id));
          else if (command.method === "approval.read")
            result = options.approvals.read(id);
          else {
            options.approvals.disable(id);
            result = { disabled: true };
          }
          break;
        }
        case "grant.revoke": {
          const p = fields(command.params, ["id"]);
          const id = string(p.id);
          const grant = options.store.getGrant(id);
          if (
            !grant ||
            options.store.getResource(grant.resourceId)?.ownerId !==
              options.owner
          )
            throw new PermissionDenied("Unknown owned root grant");
          options.store.revoke(id);
          result = { revoked: true };
          break;
        }
        case "task.end": {
          const p = fields(command.params, ["id"]);
          const id = string(p.id);
          if (options.store.getTask(id)?.ownerId !== options.owner)
            throw new PermissionDenied("Unknown owned task");
          options.store.endTask(id);
          result = { ended: true };
          break;
        }
        case "audit.read": {
          fields(command.params, []);
          result = options.audit().map((event) => ({ ...event }));
          break;
        }
        default:
          throw new RequestError(400, "Unknown command");
      }
      respond(response, 200, { ok: result });
    } catch (error) {
      respond(
        response,
        error instanceof PermissionDenied
          ? 403
          : error instanceof RequestError
            ? error.status
            : 500,
        { error: "administration_failed" },
      );
    } finally {
      active--;
    }
  };
}

export function createAdministrationClient(options: {
  url: string;
  token: string;
}) {
  validateAdminToken(options.token);
  const url = new URL(options.url);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Administration requires HTTPS or loopback HTTP");
  async function call(method: string, params: Json): Promise<Json> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({ method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Administration returned HTTP ${response.status}`);
    }
    const value = await readResponse(response);
    if (!value || typeof value !== "object" || !("ok" in value))
      throw new Error("Invalid administration response");
    return value.ok as Json;
  }
  return {
    createTask: (id: string) => call("task.create", { id }),
    async issue(input: {
      audience: Principal;
      taskId: string;
      resource: ResourceId;
      action: string;
      expiresAt: Date;
    }): Promise<Grant> {
      const value = await call("grant.issue", {
        audience: input.audience.did(),
        taskId: input.taskId,
        resource: input.resource,
        action: input.action,
        expiresAt: input.expiresAt.toISOString(),
      });
      return parseGrantResponse(value);
    },
    approveWorkflow: (input: WorkflowApprovalInput) =>
      call("approval.create", {
        id: input.id,
        audience: input.audience.did(),
        resource: input.resource,
        action: input.action,
        expiresAt: input.expiresAt.toISOString(),
        maxGrantSeconds: input.maxGrantSeconds,
      }),
    async issueApproved(id: string): Promise<Grant> {
      return parseGrantResponse(await call("approval.issue", { id }));
    },
    readApproval: (id: string) => call("approval.read", { id }),
    listApprovals: (input: { after?: string; limit?: number } = {}) =>
      call("approval.list", {
        after: input.after ?? "",
        limit: input.limit ?? 20,
      }),
    disableApproval: (id: string) => call("approval.disable", { id }),
    revoke: (id: string) => call("grant.revoke", { id }),
    endTask: (id: string) => call("task.end", { id }),
    audit: () => call("audit.read", {}),
    listGrants: async (input: InspectionQuery = {}) =>
      (await call("grant.list", {
        after: input.after ?? "",
        limit: input.limit ?? 25,
      })) as unknown as GrantPage,
    readGrant: async (id: string) =>
      (await call("grant.read", { id })) as unknown as InspectedGrant,
    listAudit: async (input: InspectionQuery = {}) =>
      (await call("audit.list", {
        after: input.after ?? "",
        limit: input.limit ?? 25,
      })) as unknown as AuditPage,
  };
}
