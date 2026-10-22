import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "@ucanto/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAdministrationClient } from "../src/administration.ts";
import { initializeService, startService } from "../src/service.ts";
import { createHttpTransport } from "../src/http.ts";
import {
  decodeGrant,
  encodeGrant,
  identity,
  PermissionDenied,
} from "../src/index.ts";
import { loadWorker, provisionWorker, renewWorker } from "../src/worker.ts";
import { readClaim } from "../src/profile.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "capvine-worker-"));
  const state = join(directory, "state");
  await initializeService(state, "owner");
  let calls = 0;
  const service = await startService({
    directory: state,
    owner: "owner",
    resources: ["one", "two"].map((id) => ({
      id: `urn:capvine:resource:${id}`,
      ownerId: "owner",
      kind: "record",
      target: { id },
    })),
    operations: ["record/read", "record/other"].map((action) => ({
      action,
      resourceKind: "record",
      execute: async (r) => {
        calls++;
        return r.target.id!;
      },
    })),
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const admin = createAdministrationClient({
    url: service.administrationUrl,
    token: (await readFile(join(state, "admin.token"), "utf8")).trim(),
  });
  const coordinator = await identity.generate();
  await admin.approveWorkflow({
    id: "report",
    audience: coordinator,
    resource: "urn:capvine:resource:one",
    action: "record/read",
    expiresAt: new Date(Date.now() + 3_600_000),
    maxGrantSeconds: 300,
  });
  const parent = await admin.issueApproved("report");
  const path = join(directory, "worker.json");
  const options = {
    path,
    coordinator,
    grant: parent,
    url: service.url,
    toolName: "read_record",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const info = await provisionWorker(options);
  const worker = await loadWorker(path);
  const server = worker.createMcpServer();
  const mcp = new Client({ name: "worker-tests", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await mcp.connect(b);
  t.after(async () => {
    await mcp.close();
    await server.close();
  });
  return {
    directory,
    path,
    options,
    info,
    worker,
    mcp,
    admin,
    parent,
    coordinator,
    service,
    calls: () => calls,
  };
}

test("worker assignment persists one identity; running direct and MCP clients follow renewal and workflow disable", async (t) => {
  const f = await fixture(t);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const original = await readFile(f.path, "utf8");
  const data = JSON.parse(original);
  assert.deepEqual(Object.keys(data).sort(), [
    "coordinator",
    "grant",
    "signer",
    "toolName",
    "url",
    "version",
  ]);
  assert.notEqual(identity.parse(data.signer).did(), f.coordinator.did());
  assert.equal(await f.worker.invoke(), "one");
  assert.deepEqual((await f.mcp.callTool({ name: "read_record" })).content, [
    { type: "text", text: '"one"' },
  ]);
  await assert.rejects(provisionWorker(f.options), /EEXIST/);
  assert.equal(await readFile(f.path, "utf8"), original);
  await f.admin.revoke(f.parent.cid.toString());
  await assert.rejects(f.worker.invoke(), PermissionDenied);
  assert.equal((await f.mcp.callTool({ name: "read_record" })).isError, true);
  assert.equal(f.calls(), 2);
  const info = await renewWorker({
    ...f.options,
    grant: await f.admin.issueApproved("report"),
  });
  assert.equal(info.worker, f.info.worker);
  assert.notEqual(info.grantId, f.info.grantId);
  assert.equal(await f.worker.invoke(), "one");
  assert.equal(
    (await f.mcp.callTool({ name: "read_record" })).isError,
    undefined,
  );
  assert.equal((await loadWorker(f.path)).assignment.worker, info.worker);
  await f.admin.disableApproval("report");
  await assert.rejects(f.admin.issueApproved("report"));
  await assert.rejects(f.worker.invoke(), PermissionDenied);
  assert.equal((await f.mcp.callTool({ name: "read_record" })).isError, true);
  assert.equal(f.calls(), 4);
});

test("renewal rejects other workflows, resources, actions, coordinators, and expiry expansion without modifying the assignment", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.path, "utf8");
  await f.admin.createTask("other");
  const base = {
    audience: f.coordinator,
    resource: "urn:capvine:resource:one" as const,
    action: "record/read",
    taskId: "approval:report",
    expiresAt: new Date(Date.now() + 120_000),
  };
  for (const changes of [
    { resource: "urn:capvine:resource:two" as const },
    { action: "record/other" },
    { taskId: "other" },
    { audience: await identity.generate() },
  ]) {
    const grant = await f.admin.issue({ ...base, ...changes });
    await assert.rejects(
      renewWorker({ ...f.options, grant }),
      PermissionDenied,
    );
  }
  await assert.rejects(
    renewWorker({ ...f.options, coordinator: await identity.generate() }),
    PermissionDenied,
  );
  await assert.rejects(
    renewWorker({
      ...f.options,
      expiresAt: new Date((f.parent.expiration + 1) * 1000),
    }),
    PermissionDenied,
  );
  await assert.rejects(
    renewWorker({ ...f.options, expiresAt: new Date(0) }),
    PermissionDenied,
  );
  await writeFile(f.path + ".lock", "", { mode: 0o600, flag: "wx" });
  await assert.rejects(renewWorker(f.options), /EEXIST/);
  await rm(f.path + ".lock");
  assert.equal(await readFile(f.path, "utf8"), original);
  assert.equal(f.calls(), 0);
});

test("loaded workers fail closed on missing, malformed, or substituted assignment files", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.path, "utf8");
  const data = JSON.parse(original);
  for (const altered of [
    "not json",
    JSON.stringify({ ...data, toolName: "different_tool" }),
    JSON.stringify({ ...data, url: "http://127.0.0.1:1/invoke" }),
    JSON.stringify({
      ...data,
      signer: identity.format(await identity.generate()),
    }),
    JSON.stringify({ ...data, operatorToken: "unexpected" }),
    JSON.stringify({ ...data, version: 2 }),
    JSON.stringify({ ...data, grant: "invalid" }),
  ]) {
    await writeFile(f.path, altered);
    await assert.rejects(f.worker.invoke());
    assert.equal((await f.mcp.callTool({ name: "read_record" })).isError, true);
  }
  await rm(f.path);
  await assert.rejects(f.worker.invoke());
  await writeFile(f.path, original, { mode: 0o600 });
  const link = join(f.directory, "link.json");
  await symlink(f.path, link);
  await assert.rejects(loadWorker(link));
  await chmod(f.path, 0o644);
  await assert.rejects(loadWorker(f.path));
  await chmod(f.path, 0o600);
  await chmod(f.directory, 0o755);
  await assert.rejects(loadWorker(f.path));
  await chmod(f.directory, 0o700);
  assert.equal(f.calls(), 0);
  assert.equal(await f.worker.invoke(), "one");
});

test("a worker bypassing the SDK still cannot change resource, action, task, service, or recipient through HTTP", async (t) => {
  const f = await fixture(t);
  const data = JSON.parse(await readFile(f.path, "utf8"));
  const signer = identity.parse(data.signer);
  const child = await decodeGrant(Buffer.from(data.grant, "base64"));
  const { action, task, service } = readClaim(child);
  const capability = {
    ...child.capabilities[0]!,
    nb: { action, task, service },
  };
  const other = await identity.generate();
  const transport = createHttpTransport({ url: f.service.url });
  for (const changed of [
    { ...capability, with: "urn:capvine:resource:two" as const },
    { ...capability, nb: { ...capability.nb, action: "record/other" } },
    { ...capability, nb: { ...capability.nb, task: "another-workflow" } },
    { ...capability, nb: { ...capability.nb, service: other.did() } },
  ]) {
    const invocation = await invoke({
      issuer: signer,
      audience: f.service.principal,
      capability: changed,
      proofs: [child],
      expiration: child.expiration,
    }).delegate();
    await assert.rejects(
      transport(await encodeGrant(invocation)),
      PermissionDenied,
    );
  }
  const stolen = await invoke({
    issuer: other,
    audience: f.service.principal,
    capability,
    proofs: [child],
    expiration: child.expiration,
  }).delegate();
  await assert.rejects(transport(await encodeGrant(stolen)), PermissionDenied);
  assert.equal(f.calls(), 0);
});
