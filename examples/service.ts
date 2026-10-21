import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  identity,
  PermissionDenied,
  type Resource,
} from "../src/index.ts";
import { createHttpTransport } from "../src/http.ts";
import { createAdministrationClient } from "../src/administration.ts";
import { initializeService, startService } from "../src/service.ts";

const temporary = await mkdtemp(join(tmpdir(), "capvine-service-example-"));
const directory = join(temporary, "authority");
const owner = "example-owner";
const resource: Resource = {
  id: "urn:capvine:resource:example",
  ownerId: owner,
  kind: "example.record",
  target: { id: "example-record" },
};
const options = {
  directory,
  owner,
  resources: [resource],
  operations: [
    {
      action: "example/read",
      resourceKind: resource.kind,
      execute: async (bound: Readonly<Resource>) => ({
        id: bound.target.id!,
        title: "A protected record",
      }),
    },
  ],
};
await initializeService(directory, owner);
let service = await startService(options);
try {
  const administrator = createAdministrationClient({
    url: service.administrationUrl,
    token: (await readFile(join(directory, "admin.token"), "utf8")).trim(),
  });
  const worker = await identity.generate();
  await administrator.createTask("read-record");
  const grant = await administrator.issue({
    audience: worker,
    taskId: "read-record",
    resource: resource.id,
    action: "example/read",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const client = () =>
    createClient({
      signer: worker,
      service: service.principal,
      transport: createHttpTransport({ url: service.url }),
    });
  assert.deepEqual(await client().invoke(grant), {
    id: "example-record",
    title: "A protected record",
  });
  await administrator.revoke(grant.cid.toString());
  await service.close();
  service = await startService(options);
  await assert.rejects(client().invoke(grant), PermissionDenied);
  console.log(
    "Authenticated grant issuance, bounded HTTP read, and revocation after restart passed.",
  );
} finally {
  await service.close();
  await rm(temporary, { recursive: true, force: true });
}
