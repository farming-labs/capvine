import { randomUUID } from "node:crypto";
import { mkdir, open, opendir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { createAdministrationClient } from "./administration.ts";
import type { WorkflowApproval } from "./approvals.ts";
import {
  assertPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "./identity-file.ts";
import { createHttpTransport } from "./http.ts";
import { loadWorker, provisionWorker, renewWorker } from "./worker.ts";
import { readClaim } from "./profile.ts";
import {
  PermissionDenied,
  type Identity,
  type Json,
  type Principal,
  type ResourceId,
} from "./types.ts";

export interface WorkflowDefinition {
  id: string;
  label: string;
  resource: ResourceId;
  action: string;
  toolName: string;
  approvalSeconds: number;
  grantSeconds: number;
  workerSeconds: number;
}
type Approval = WorkflowApproval & { active: boolean };
const uuid =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const workerId = new RegExp(`^${uuid}$`);
const approvalId = new RegExp(`^wf[.]([a-z][a-z0-9-]{0,31})[.](${uuid})$`);
function record(value: Json) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workflow response");
  return value;
}

export async function openWorkflowManager(options: {
  directory: string;
  ownerId: string;
  coordinator: Identity;
  service: Principal;
  url: string;
  administration: ReturnType<typeof createAdministrationClient>;
  workflows: WorkflowDefinition[];
  workerCommand?: { command: string; args: string[] };
}) {
  const definitions = structuredClone(options.workflows);
  const workerCommand = structuredClone(
    options.workerCommand ?? { command: "capvine", args: [] },
  );
  if (
    !workerCommand.command ||
    workerCommand.command.length > 4096 ||
    workerCommand.args.length > 16 ||
    workerCommand.args.some(
      (arg) => typeof arg !== "string" || arg.length > 4096,
    )
  )
    throw new Error("Invalid worker command");
  if (
    !isAbsolute(options.directory) ||
    !options.ownerId ||
    options.ownerId.length > 256 ||
    !definitions.length ||
    definitions.length > 32 ||
    new Set(definitions.map((item) => item.id)).size !== definitions.length
  )
    throw new Error("Invalid workflow configuration");
  for (const item of definitions) {
    if (
      !/^[a-z][a-z0-9-]{0,31}$/.test(item.id) ||
      !item.label ||
      item.label.length > 128 ||
      !item.resource.startsWith("urn:capvine:resource:") ||
      !item.action ||
      item.action.length > 1024 ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.toolName) ||
      !Number.isSafeInteger(item.approvalSeconds) ||
      item.approvalSeconds < 60 ||
      item.approvalSeconds > 31 * 86_400 ||
      !Number.isSafeInteger(item.grantSeconds) ||
      item.grantSeconds < 60 ||
      item.grantSeconds > 3600 ||
      !Number.isSafeInteger(item.workerSeconds) ||
      item.workerSeconds < 60 ||
      item.workerSeconds > item.grantSeconds
    )
      throw new Error("Invalid workflow definition");
  }
  createHttpTransport({ url: options.url });
  await mkdir(options.directory, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await assertPrivateDirectory(options.directory);
  const lockPath = join(options.directory, "manager.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const bindingPath = join(options.directory, "binding.json");
  const binding = JSON.stringify({
    ownerId: options.ownerId,
    coordinator: options.coordinator.did(),
    service: options.service.did(),
    url: options.url,
  });
  try {
    await lock.writeFile(String(process.pid));
    try {
      if ((await readPrivateFile(bindingPath)) !== binding)
        throw new Error("Workflow directory belongs to another binding");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const entries = await opendir(options.directory);
      for await (const entry of entries)
        if (entry.name !== "manager.lock")
          throw new Error("Existing workflow files require a binding");
      await writePrivateFile(bindingPath, binding);
    }
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
  const admin = options.administration;
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let closing: Promise<void> | undefined;
  let renewalFailed = false;
  function run<T>(fn: () => Promise<T>): Promise<T> {
    if (closing || pending >= 32)
      return Promise.reject(new Error("Workflow manager unavailable"));
    pending++;
    const job = tail.then(fn);
    tail = job
      .catch(() => {})
      .finally(() => {
        pending--;
      });
    return job;
  }
  function parseApproval(value: Json): Approval {
    const row = record(value);
    if (
      typeof row.id !== "string" ||
      !approvalId.test(row.id) ||
      row.ownerId !== options.ownerId ||
      row.audience !== options.coordinator.did() ||
      typeof row.resource !== "string" ||
      !row.resource.startsWith("urn:capvine:resource:") ||
      typeof row.action !== "string" ||
      row.taskId !== `approval:${row.id}` ||
      typeof row.active !== "boolean" ||
      !Number.isSafeInteger(row.expiresAt) ||
      !Number.isSafeInteger(row.maxGrantSeconds)
    )
      throw new PermissionDenied("Unknown configured workflow approval");
    return row as unknown as Approval;
  }
  function definition(approval: Approval) {
    const id = approvalId.exec(approval.id)![1];
    return definitions.find(
      (item) =>
        item.id === id &&
        item.resource === approval.resource &&
        item.action === approval.action &&
        item.grantSeconds === approval.maxGrantSeconds,
    );
  }
  async function approved(id: string, active = true) {
    if (!approvalId.test(id))
      throw new PermissionDenied("Unknown workflow approval");
    const approval = parseApproval(await admin.readApproval(id));
    if (
      approval.id !== id ||
      (active && (!approval.active || !definition(approval)))
    )
      throw new PermissionDenied(
        "Workflow is inactive or no longer configured",
      );
    return approval;
  }
  async function issue(approval: Approval) {
    const parent = await admin.issueApproved(approval.id);
    const claim = readClaim(parent);
    if (
      claim.resource !== approval.resource ||
      claim.action !== approval.action ||
      claim.task !== approval.taskId ||
      claim.service !== options.service.did() ||
      parent.audience.did() !== options.coordinator.did() ||
      parent.issuer.did() !== options.service.did() ||
      parent.expiration > approval.expiresAt ||
      parent.expiration >
        Math.floor(Date.now() / 1000) + approval.maxGrantSeconds
    )
      throw new PermissionDenied(
        "Issued grant does not match the saved approval",
      );
    return parent;
  }
  function path(id: string) {
    if (!workerId.test(id)) throw new PermissionDenied("Unknown worker");
    return join(options.directory, id + ".json");
  }
  async function workers() {
    const result: {
      id: string;
      path: string;
      assignment: Awaited<ReturnType<typeof loadWorker>>["assignment"];
    }[] = [];
    const unavailable: string[] = [];
    const entries = await opendir(options.directory);
    for await (const entry of entries) {
      if (!entry.name.endsWith(".json") || entry.name === "binding.json")
        continue;
      const id = entry.name.slice(0, -5);
      if (result.length + unavailable.length >= 32)
        throw new Error("Worker limit exceeded");
      try {
        const assignment = (await loadWorker(path(id))).assignment;
        if (
          assignment.coordinator !== options.coordinator.did() ||
          assignment.service !== options.service.did() ||
          assignment.url !== options.url ||
          !approvalId.test(assignment.task.slice("approval:".length)) ||
          !assignment.task.startsWith("approval:")
        )
          throw new PermissionDenied(
            "Worker belongs to another workflow manager",
          );
        result.push({ id, path: path(id), assignment });
      } catch {
        unavailable.push(id);
      }
    }
    return {
      workers: result.sort((a, b) => (a.id < b.id ? -1 : 1)),
      unavailable,
    };
  }
  async function renew(id: string) {
    const worker = (await loadWorker(path(id))).assignment;
    const approval = await approved(worker.task.slice("approval:".length));
    const item = definition(approval)!;
    if (
      worker.task !== approval.taskId ||
      worker.resource !== approval.resource ||
      worker.action !== approval.action ||
      worker.service !== options.service.did() ||
      worker.coordinator !== options.coordinator.did() ||
      worker.url !== options.url ||
      worker.toolName !== item.toolName
    )
      throw new PermissionDenied("Worker changed its approved binding");
    const parent = await issue(approval);
    return renewWorker({
      path: path(id),
      coordinator: options.coordinator,
      grant: parent,
      expiresAt: new Date(
        Math.min(
          parent.expiration,
          Math.floor(Date.now() / 1000) + item.workerSeconds,
        ) * 1000,
      ),
    });
  }
  return {
    ownerId: options.ownerId,
    list(input: { after?: string } = {}) {
      return run(async () => {
        const listing = record(
          await admin.listApprovals({ ...input, limit: 20 }),
        );
        if (
          !Array.isArray(listing.approvals) ||
          (listing.nextCursor !== null &&
            typeof listing.nextCursor !== "string")
        )
          throw new Error("Invalid approval listing");
        const approvals = listing.approvals
          .filter((value) => {
            const row = record(value);
            return (
              typeof row.id === "string" &&
              approvalId.test(row.id) &&
              row.audience === options.coordinator.did()
            );
          })
          .map(parseApproval)
          .map((approval) => ({
            ...approval,
            configured: !!definition(approval),
          }));
        const rows = await workers();
        return {
          definitions: structuredClone(definitions),
          approvals,
          workers: rows.workers.filter((worker) =>
            approvals.some(
              (approval) => approval.taskId === worker.assignment.task,
            ),
          ),
          nextCursor: listing.nextCursor,
          renewalFailed,
          unavailableWorkers: rows.unavailable,
          workerCommand: structuredClone(workerCommand),
        };
      });
    },
    approve(id: string) {
      return run(async () => {
        const item = definitions.find((item) => item.id === id);
        if (!item) throw new PermissionDenied("Unknown workflow definition");
        const approval = `wf.${item.id}.${randomUUID()}`;
        await admin.approveWorkflow({
          id: approval,
          audience: options.coordinator,
          resource: item.resource,
          action: item.action,
          expiresAt: new Date(Date.now() + item.approvalSeconds * 1000),
          maxGrantSeconds: item.grantSeconds,
        });
        return approved(approval);
      });
    },
    provision(id: string) {
      return run(async () => {
        const approval = await approved(id);
        const item = definition(approval)!;
        const existing = await workers();
        if (existing.workers.length + existing.unavailable.length >= 32)
          throw new Error("Worker limit reached");
        const parent = await issue(approval);
        const worker = randomUUID();
        const assignment = await provisionWorker({
          path: path(worker),
          coordinator: options.coordinator,
          grant: parent,
          url: options.url,
          toolName: item.toolName,
          expiresAt: new Date(
            Math.min(
              parent.expiration,
              Math.floor(Date.now() / 1000) + item.workerSeconds,
            ) * 1000,
          ),
        });
        return { id: worker, path: path(worker), assignment };
      });
    },
    renew(id: string) {
      return run(() => renew(id));
    },
    disable(id: string) {
      return run(async () => {
        await approved(id, false);
        await admin.disableApproval(id);
      });
    },
    renewDue() {
      return run(async () => {
        const listing = await workers();
        renewalFailed = listing.unavailable.length > 0;
        const deadline = Date.now() + 10_000;
        for (const worker of listing.workers) {
          if (Date.now() >= deadline) {
            renewalFailed = true;
            break;
          }
          if (
            new Date(worker.assignment.expiresAt).getTime() >
            Date.now() + 30_000
          )
            continue;
          try {
            const approval = await approved(
              worker.assignment.task.slice("approval:".length),
              false,
            );
            if (approval.active && definition(approval)) await renew(worker.id);
          } catch {
            renewalFailed = true;
          }
        }
      }).catch((error) => {
        renewalFailed = true;
        throw error;
      });
    },
    close() {
      return (closing ??= (async () => {
        await tail;
        await lock.close();
        await unlink(lockPath);
      })());
    },
  };
}

export type WorkflowManager = Awaited<ReturnType<typeof openWorkflowManager>>;
