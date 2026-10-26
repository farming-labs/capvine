import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  assertPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "../../src/identity-file.ts";
import { loadWorker } from "../../src/worker.ts";
import { PermissionDenied } from "../../src/types.ts";

function absolute(path: string) {
  if (!isAbsolute(path)) throw new Error("Absolute private path required");
  return path;
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function usable(worker: Awaited<ReturnType<typeof loadWorker>>) {
  const endpoint = new URL(worker.assignment.url);
  if (
    endpoint.search ||
    !["/invoke", "/api/capvine/invoke"].includes(endpoint.pathname) ||
    !Number.isFinite(Date.parse(worker.assignment.expiresAt)) ||
    Date.parse(worker.assignment.expiresAt) <= Date.now() + 15_000
  )
    throw new Error("Use a fixed invocation endpoint and unexpired assignment");
}

async function unchanged(path: string, expected: string) {
  if (digest(await readPrivateFile(path, 65_536)) !== expected)
    throw new Error("Worker assignment changed during validation");
}

export async function captureWorker(assignment: string, directory: string) {
  absolute(directory);
  absolute(assignment);
  await assertPrivateDirectory(dirname(directory));
  await assertPrivateDirectory(dirname(assignment));
  const content = await readPrivateFile(assignment, 65_536);
  await mkdir(directory, { mode: 0o700 });
  try {
    const path = join(directory, "worker.json");
    await writePrivateFile(path, content);
    const worker = await loadWorker(path);
    usable(worker);
    await worker.invoke();
    usable(worker);
    const sha256 = digest(content);
    await unchanged(path, sha256);
    await writePrivateFile(
      join(directory, "receipt.json"),
      JSON.stringify({
        version: 1,
        sha256,
        capturedAt: new Date().toISOString(),
      }),
    );
    return { retainedAssignment: true, originalReadSucceeded: true };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function compareWorkers(
  directory: string,
  freshAssignment: string,
) {
  absolute(directory);
  absolute(freshAssignment);
  await assertPrivateDirectory(directory);
  await assertPrivateDirectory(dirname(freshAssignment));
  const input: unknown = JSON.parse(
    await readPrivateFile(join(directory, "receipt.json")),
  );
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid capture receipt");
  const receipt = input as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(",") !== "capturedAt,sha256,version" ||
    receipt.version !== 1 ||
    typeof receipt.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
    typeof receipt.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.capturedAt)) ||
    Date.parse(receipt.capturedAt) > Date.now()
  )
    throw new Error("Invalid capture receipt");
  const retainedPath = join(directory, "worker.json");
  await unchanged(retainedPath, receipt.sha256);
  const freshDigest = digest(await readPrivateFile(freshAssignment, 65_536));
  const retained = await loadWorker(retainedPath);
  const fresh = await loadWorker(freshAssignment);
  usable(retained);
  usable(fresh);
  if (
    retained.assignment.url !== fresh.assignment.url ||
    retained.assignment.service !== fresh.assignment.service ||
    retained.assignment.action !== fresh.assignment.action ||
    retained.assignment.resource === fresh.assignment.resource ||
    retained.assignment.grantId === fresh.assignment.grantId ||
    retained.assignment.worker === fresh.assignment.worker
  )
    throw new Error(
      "Expected a new worker/resource at the same service and endpoint",
    );
  await fresh.invoke();
  let denied = false;
  try {
    await retained.invoke();
  } catch (error) {
    if (!(error instanceof PermissionDenied)) throw error;
    denied = true;
  }
  if (!denied) throw new Error("The retained worker still has access");
  usable(retained);
  usable(fresh);
  await unchanged(retainedPath, receipt.sha256);
  await unchanged(freshAssignment, freshDigest);
  return {
    retainedAssignmentUnchanged: true,
    assignmentsUnexpired: true,
    sameServiceAndEndpoint: true,
    freshWorkerAndResource: true,
    freshReadSucceeded: true,
    retainedInvocationDenied: true,
  };
}
