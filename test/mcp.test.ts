import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import {
  createClient,
  identity,
  PermissionDenied,
  type Grant,
} from "../src/index.ts";
import { createHttpTransport } from "../src/http.ts";
import { initializeService, startService } from "../src/service.ts";
import { createAdministrationClient } from "../src/administration.ts";

async function session(
  t: TestContext,
  options: Parameters<typeof createMcpServer>[0],
) {
  const server = createMcpServer(options);
  const client = new Client({ name: "worker-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test("MCP sessions bind worker, task, service, and grants through the HTTP verifier", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capvine-mcp-"));
  const directory = join(dir, "state");
  await initializeService(directory, "owner");
  let calls = 0;
  const service = await startService({
    directory,
    owner: "owner",
    resources: [
      {
        id: "urn:capvine:resource:one",
        ownerId: "owner",
        kind: "record",
        target: { id: "one" },
      },
      {
        id: "urn:capvine:resource:two",
        ownerId: "owner",
        kind: "record",
        target: { id: "two" },
      },
    ],
    operations: [
      {
        action: "record/read",
        resourceKind: "record",
        execute: async (r) => {
          calls++;
          return r.target.id!;
        },
      },
    ],
  });
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const admin = createAdministrationClient({
    url: service.administrationUrl,
    token: (await readFile(join(directory, "admin.token"), "utf8")).trim(),
  });
  await admin.createTask("job");
  await admin.createTask("other-job");
  const coordinator = await identity.generate();
  const worker = await identity.generate();
  const transport = createHttpTransport({ url: service.url });
  const parent = await admin.issue({
    audience: coordinator,
    taskId: "job",
    resource: "urn:capvine:resource:one",
    action: "record/read",
    expiresAt: new Date(Date.now() + 120_000),
  });
  const parentClient = createClient({
    signer: coordinator,
    service: service.principal,
    transport,
  });
  const child = await parentClient.delegate({
    grant: parent,
    audience: worker,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const options = {
    signer: worker,
    service: service.principal,
    taskId: "job",
    transport,
    tools: [{ name: "read_assigned", grant: child }],
  };
  assert.throws(
    () => createMcpServer({ ...options, signer: coordinator }),
    PermissionDenied,
  );
  assert.throws(
    () => createMcpServer({ ...options, taskId: "other-job" }),
    PermissionDenied,
  );
  assert.throws(
    () =>
      createMcpServer({
        ...options,
        service: { did: () => coordinator.did() },
      }),
    PermissionDenied,
  );
  const client = await session(t, options);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["read_assigned"],
  );
  const result = await client.callTool({
    name: "read_assigned",
    arguments: {},
  });
  assert.deepEqual(result.content, [{ type: "text", text: '"one"' }]);
  for (const args of [
    { resource: "urn:capvine:resource:two" },
    { taskId: "other-job" },
    { actor: "owner" },
    { grant: "replacement" },
  ])
    assert.equal(
      (await client.callTool({ name: "read_assigned", arguments: args }))
        .isError,
      true,
    );
  assert.equal(
    (await client.callTool({ name: "other_tool", arguments: {} })).isError,
    true,
  );
  assert.equal(calls, 1);
  await admin.revoke(parent.cid.toString());
  const resumed = await session(t, options);
  assert.equal(
    (await resumed.callTool({ name: "read_assigned" })).isError,
    true,
  );
  assert.equal(calls, 1);
  const other: Grant = await admin.issue({
    audience: worker,
    taskId: "other-job",
    resource: "urn:capvine:resource:two",
    action: "record/read",
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.throws(
    () =>
      createMcpServer({ ...options, tools: [{ name: "other", grant: other }] }),
    PermissionDenied,
  );
});
