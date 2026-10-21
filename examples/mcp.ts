import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient, encodeGrant, identity } from "../src/index.ts";
import { createAdministrationClient } from "../src/administration.ts";
import { createHttpTransport } from "../src/http.ts";
import { writePrivateFile } from "../src/identity-file.ts";
import { initializeService, startService } from "../src/service.ts";

const temporary = await mkdtemp(join(tmpdir(), "capvine-mcp-example-"));
const directory = join(temporary, "state");
await initializeService(directory, "example-owner");
const service = await startService({
  directory,
  owner: "example-owner",
  resources: [
    {
      id: "urn:capvine:resource:example",
      ownerId: "example-owner",
      kind: "example",
      target: { record: "assigned" },
    },
  ],
  operations: [
    {
      action: "example/read",
      resourceKind: "example",
      execute: async (r) => r.target.record!,
    },
  ],
});
const mcp = new Client({ name: "example-runtime", version: "1.0.0" });
try {
  const admin = createAdministrationClient({
    url: service.administrationUrl,
    token: (await readFile(join(directory, "admin.token"), "utf8")).trim(),
  });
  await admin.createTask("example-job");
  const coordinator = await identity.generate();
  const worker = await identity.generate();
  const parent = await admin.issue({
    audience: coordinator,
    taskId: "example-job",
    resource: "urn:capvine:resource:example",
    action: "example/read",
    expiresAt: new Date(Date.now() + 120_000),
  });
  const client = createClient({
    signer: coordinator,
    service: service.principal,
    transport: createHttpTransport({ url: service.url }),
  });
  const child = await client.delegate({
    grant: parent,
    audience: worker,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const config = join(temporary, "worker.json");
  await writePrivateFile(
    config,
    JSON.stringify({
      signer: identity.format(worker),
      service: service.principal.did(),
      taskId: "example-job",
      url: service.url,
      grant: Buffer.from(await encodeGrant(child)).toString("base64"),
    }),
  );
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("./mcp-worker.ts", import.meta.url)),
        config,
      ],
      env: {},
      stderr: "pipe",
    }),
  );
  assert.deepEqual(
    (await mcp.listTools()).tools.map((tool) => tool.name),
    ["read_assigned_record"],
  );
  assert.deepEqual(
    (await mcp.callTool({ name: "read_assigned_record" })).content,
    [{ type: "text", text: '"assigned"' }],
  );
  assert.equal(
    (
      await mcp.callTool({
        name: "read_assigned_record",
        arguments: { resource: "other" },
      })
    ).isError,
    true,
  );
  await admin.revoke(parent.cid.toString());
  assert.equal(
    (await mcp.callTool({ name: "read_assigned_record" })).isError,
    true,
  );
  console.log(
    "Separate stdio worker read its delegated resource, refused overrides, and honored parent revocation.",
  );
} finally {
  await mcp.close();
  await service.close();
  await rm(temporary, { recursive: true, force: true });
}
