import { randomBytes, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { ed25519 } from "@ucanto/principal";
import { createClient } from "./client.ts";
import { createHttpTransport } from "./http.ts";
import {
  assertPrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "./identity-file.ts";
import { createMcpServer } from "./mcp.ts";
import { decodeGrant, encodeGrant, readClaim } from "./profile.ts";
import { PermissionDenied, type Grant, type Identity } from "./types.ts";

interface Assignment {
  version: 1;
  signer: string;
  coordinator: string;
  url: string;
  toolName: string;
  grant: string;
}

async function privatePath(path: string) {
  if (!isAbsolute(path))
    throw new Error("Worker assignment requires an absolute path");
  await assertPrivateDirectory(dirname(path));
}

async function readAssignment(path: string) {
  await privatePath(path);
  const input: unknown = JSON.parse(await readPrivateFile(path, 65_536));
  const keys = ["version", "signer", "coordinator", "url", "toolName", "grant"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key))
  )
    throw new Error("Invalid worker assignment");
  const data = input as Assignment;
  if (
    data.version !== 1 ||
    keys
      .slice(1)
      .some((key) => typeof data[key as keyof Assignment] !== "string")
  )
    throw new Error("Invalid worker assignment");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(data.toolName))
    throw new Error("Invalid worker tool name");
  createHttpTransport({ url: data.url });
  ed25519.Verifier.parse(data.coordinator as `did:key:${string}`);
  const signer = ed25519.parse(data.signer);
  const challenge = randomBytes(32);
  if (!(await signer.verifier.verify(challenge, await signer.sign(challenge))))
    throw new Error("Worker identity is inconsistent");
  const grant = await decodeGrant(Buffer.from(data.grant, "base64"));
  const claim = readClaim(grant);
  const service = ed25519.Verifier.parse(claim.service);
  if (
    grant.audience.did() !== signer.did() ||
    grant.issuer.did() !== data.coordinator
  )
    throw new PermissionDenied(
      "Grant does not belong to this worker assignment",
    );
  return { data, signer, grant, claim, service };
}

function describe(assignment: Awaited<ReturnType<typeof readAssignment>>) {
  return {
    worker: assignment.signer.did(),
    coordinator: assignment.data.coordinator,
    url: assignment.data.url,
    toolName: assignment.data.toolName,
    ...assignment.claim,
    grantId: assignment.grant.cid.toString(),
    expiresAt: new Date(assignment.grant.expiration * 1000).toISOString(),
  };
}

function unchanged(
  before: Awaited<ReturnType<typeof readAssignment>>,
  after: Awaited<ReturnType<typeof readAssignment>>,
) {
  if (
    after.data.signer !== before.data.signer ||
    after.data.coordinator !== before.data.coordinator ||
    after.data.url !== before.data.url ||
    after.data.toolName !== before.data.toolName ||
    after.claim.resource !== before.claim.resource ||
    after.claim.action !== before.claim.action ||
    after.claim.task !== before.claim.task ||
    after.claim.service !== before.claim.service
  )
    throw new PermissionDenied("Worker assignment changed its fixed binding");
}

async function serialize(data: Omit<Assignment, "grant">, grant: Grant) {
  const content = JSON.stringify({
    ...data,
    grant: Buffer.from(await encodeGrant(grant)).toString("base64"),
  });
  if (Buffer.byteLength(content) > 65_536)
    throw new Error("Worker assignment is too large");
  return content;
}

/** Trusted provisioning code creates a file containing only one worker's authority. */
export async function provisionWorker(options: {
  path: string;
  coordinator: Identity;
  grant: Grant;
  url: string;
  toolName: string;
  expiresAt: Date;
}) {
  await privatePath(options.path);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(options.toolName))
    throw new Error("Invalid worker tool name");
  const claim = readClaim(options.grant);
  const signer = await ed25519.generate();
  const client = createClient({
    signer: options.coordinator,
    service: ed25519.Verifier.parse(claim.service),
    transport: createHttpTransport({ url: options.url }),
  });
  const child = await client.delegate({
    grant: options.grant,
    audience: signer,
    expiresAt: options.expiresAt,
  });
  const content = await serialize(
    {
      version: 1,
      signer: ed25519.format(signer),
      coordinator: options.coordinator.did(),
      url: options.url,
      toolName: options.toolName,
    },
    child,
  );
  await writePrivateFile(options.path, content);
  return describe(await readAssignment(options.path));
}

/** A fresh approved parent may renew a worker, but cannot retarget its assignment. */
export async function renewWorker(options: {
  path: string;
  coordinator: Identity;
  grant: Grant;
  expiresAt: Date;
}) {
  await privatePath(options.path);
  const lockPath = options.path + ".lock";
  const lock = await open(lockPath, "wx", 0o600);
  const temporary = options.path + "." + randomUUID() + ".tmp";
  let created = false;
  try {
    const before = await readAssignment(options.path);
    const claim = readClaim(options.grant);
    if (
      options.coordinator.did() !== before.data.coordinator ||
      claim.resource !== before.claim.resource ||
      claim.action !== before.claim.action ||
      claim.task !== before.claim.task ||
      claim.service !== before.claim.service
    )
      throw new PermissionDenied("Renewal changed the assigned workflow");
    const client = createClient({
      signer: options.coordinator,
      service: before.service,
      transport: createHttpTransport({ url: before.data.url }),
    });
    const child = await client.delegate({
      grant: options.grant,
      audience: before.signer,
      expiresAt: options.expiresAt,
    });
    await writePrivateFile(temporary, await serialize(before.data, child));
    created = true;
    unchanged(before, await readAssignment(options.path));
    await rename(temporary, options.path);
    created = false;
    const directory = await open(dirname(options.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return describe(await readAssignment(options.path));
  } finally {
    try {
      if (created) await unlink(temporary);
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

/** Load once to pin the binding; reload only renewed proofs on subsequent calls. */
export async function loadWorker(path: string) {
  const initial = await readAssignment(path);
  const transport = createHttpTransport({ url: initial.data.url });
  const client = createClient({
    signer: initial.signer,
    service: initial.service,
    transport,
  });
  const loadGrant = async () => {
    const current = await readAssignment(path);
    unchanged(initial, current);
    return current.grant;
  };
  return {
    assignment: describe(initial),
    async invoke() {
      return client.invoke(await loadGrant());
    },
    createMcpServer() {
      return createMcpServer({
        signer: initial.signer,
        service: initial.service,
        taskId: initial.claim.task,
        transport,
        tools: [
          { name: initial.data.toolName, grant: initial.grant, loadGrant },
        ],
      });
    },
  };
}
