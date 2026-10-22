import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "@ucanto/client";
import {
  createClient,
  encodeGrant,
  identity,
  PermissionDenied,
  type Grant,
} from "../src/index.ts";
import { createHttpTransport } from "../src/http.ts";
import { createAdministrationClient } from "../src/administration.ts";
import { initializeService } from "../src/service.ts";
import { startResourceServer } from "../src/adapter.ts";
import { createFilesystemAdapter } from "../src/filesystem.ts";
import { readPrivateFile, writePrivateFile } from "../src/identity-file.ts";

const temporary = await mkdtemp(join(tmpdir(), "capvine-recovery-"));
const owner = "recovery-owner";
const resource = "urn:capvine:resource:recovery-report";
const data = join(temporary, "data");
const current = join(temporary, "current");
const beforeRevocation = join(temporary, "before-revocation");
const afterRevocation = join(temporary, "after-revocation");
let service: Awaited<ReturnType<typeof startResourceServer>> | undefined;
const start = async (directory: string) =>
  startResourceServer({
    directory,
    owner,
    adapters: [
      await createFilesystemAdapter({
        root: data,
        ownerId: owner,
        connectionId: "recovery-files",
        files: [{ id: resource, path: "report.txt" }],
      }),
    ],
  });
const admin = (token: string) =>
  createAdministrationClient({ url: service!.administrationUrl, token });
const coordinator = await identity.generate();
const worker = await identity.generate();
const client = (signer = worker) =>
  createClient({
    signer,
    service: service!.principal,
    transport: createHttpTransport({ url: service!.url }),
  });
const delegate = (grant: Grant) =>
  client(coordinator).delegate({
    grant,
    audience: worker,
    expiresAt: new Date(Date.now() + 120_000),
  });
try {
  await mkdir(data, { mode: 0o700 });
  await writePrivateFile(join(data, "report.txt"), "Recovery fixture\n");
  const originalDid = await initializeService(current, owner);
  service = await start(current);
  const token = await readPrivateFile(join(current, "admin.token"));
  await admin(token).approveWorkflow({
    id: "report",
    audience: coordinator,
    resource,
    action: "fs/read",
    expiresAt: new Date(Date.now() + 3600_000),
    maxGrantSeconds: 600,
  });
  const parent = await admin(token).issueApproved("report");
  const child = await delegate(parent);
  const expected = await client().invoke(child);
  await assert.rejects(start(current), { code: "EEXIST" });
  await service.close();
  await cp(current, beforeRevocation, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  service = await start(current);
  await admin(token).revoke(parent.cid.toString());
  await admin(token).disableApproval("report");
  await service.close();
  await cp(current, afterRevocation, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  service = await start(afterRevocation);
  assert.equal(service.principal.did(), originalDid);
  await assert.rejects(client().invoke(child), PermissionDenied);
  await assert.rejects(admin(token).issueApproved("report"), /403/);
  await service.close();
  console.log(
    "A stopped, consistent backup retained identity, parent revocation, and workflow disable after restoration.",
  );

  service = await start(beforeRevocation);
  assert.deepEqual(await client().invoke(child), expected);
  await service.close();
  console.log(
    "An isolated stale-backup rehearsal reproduced rollback of revoked access. It must not be returned to service.",
  );

  const recovered = join(temporary, "recovered");
  const newDid = await initializeService(recovered, owner);
  assert.notEqual(newDid, originalDid);
  service = await start(recovered);
  const newToken = await readPrivateFile(join(recovered, "admin.token"));
  await assert.rejects(admin(token).audit(), /401/);
  await assert.rejects(admin(newToken).issueApproved("report"), /403/);
  const replay = await invoke({
    issuer: worker,
    audience: service.principal,
    capability: child.capabilities[0]!,
    proofs: [child],
    expiration: child.expiration,
  }).delegate();
  await assert.rejects(
    createHttpTransport({ url: service.url })(await encodeGrant(replay)),
    PermissionDenied,
  );
  await admin(newToken).approveWorkflow({
    id: "report-reapproved",
    audience: coordinator,
    resource,
    action: "fs/read",
    expiresAt: new Date(Date.now() + 3600_000),
    maxGrantSeconds: 600,
  });
  const replacement = await delegate(
    await admin(newToken).issueApproved("report-reapproved"),
  );
  assert.deepEqual(await client().invoke(replacement), expected);
  await service.close();
  console.log(
    "A fresh authority rejected the old signed proof at the server, required a new approval, and accepted a newly pinned grant.",
  );

  const rotated = randomBytes(32).toString("base64url");
  await writeFile(join(recovered, "admin.token"), rotated, { mode: 0o600 });
  service = await start(recovered);
  await assert.rejects(admin(newToken).audit(), /401/);
  await admin(rotated).audit();
  assert.deepEqual(await client().invoke(replacement), expected);
  await service.close();

  const mismatch = join(temporary, "mismatch");
  await cp(afterRevocation, mismatch, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(
    join(mismatch, "authority.key"),
    identity.format(await identity.generate()),
    { mode: 0o600 },
  );
  await assert.rejects(start(mismatch), /another authority/);
  console.log(
    "Operator-token rotation rejected the old token without invalidating worker grants; mismatched identity/state and concurrent ownership rejected startup.",
  );
  console.log(
    "Temporary local fixtures only. Host isolation, off-host backup durability, TLS, real credentials, and live provider recovery require separate validation.",
  );
} finally {
  await service?.close();
  await rm(temporary, { recursive: true, force: true });
}
