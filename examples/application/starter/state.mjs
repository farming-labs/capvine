import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "@farming-labs/capvine/identity-file";

export function dataDirectory() {
  const path =
    process.env.CAPVINE_STARTER_DATA ??
    fileURLToPath(new URL(".data", import.meta.url));
  if (!isAbsolute(path))
    throw new Error("CAPVINE_STARTER_DATA must be absolute");
  return path;
}

export function localOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Use a loopback origin such as http://127.0.0.1:8800");
  return url.origin;
}

export async function readSettings(directory) {
  await assertPrivateDirectory(directory);
  const settings = JSON.parse(
    await readPrivateFile(join(directory, "settings.json")),
  );
  localOrigin(settings.baseURL);
  if (typeof settings.ownerId !== "string" || !settings.ownerId)
    throw new Error("Invalid owner configuration");
  return settings;
}

export async function readJob(directory) {
  try {
    const job = JSON.parse(await readPrivateFile(join(directory, "job.json")));
    if (
      !/^[a-f0-9-]{36}$/.test(job.id) ||
      typeof job.grantId !== "string" ||
      !job.resource?.startsWith("urn:capvine:resource:") ||
      !Number.isSafeInteger(job.expiresAt) ||
      typeof job.revoked !== "boolean" ||
      (job.disabled !== undefined && typeof job.disabled !== "boolean") ||
      (job.workflowId !== undefined &&
        (typeof job.workflowId !== "string" ||
          !job.workflowId.startsWith("app.") ||
          !Number.isSafeInteger(job.workflowExpiresAt) ||
          typeof job.disabled !== "boolean"))
    )
      throw new Error("Invalid saved job");
    return job;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveJob(directory, job) {
  const temporary = join(directory, `job-${randomUUID()}.tmp`);
  await writePrivateFile(temporary, JSON.stringify(job));
  try {
    await rename(temporary, join(directory, "job.json"));
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function assignmentPath(directory, job) {
  return join(directory, "workers", job.id, "assignment.json");
}
