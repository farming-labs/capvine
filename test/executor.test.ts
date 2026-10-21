import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { invoke } from "@ucanto/client";
import { createExecutorGmailAdapter } from "../src/executor.ts";
import {
  createAuthority,
  createClient,
  identity,
  MemoryStore,
  encodeGrant,
  PermissionDenied,
} from "../src/index.ts";
import {
  inspectAccount,
  readBoundMessage,
} from "../examples/executor/app/read.ts";

const binding = {
  accountId: "account-a",
  subject: "subject-a",
  messageId: "a42",
};
const resourceId = "urn:capvine:resource:mail" as const;
const path = 'tools["mail"].readMessage';
function success() {
  return {
    status: "completed",
    execution: {
      ok: true,
      value: {
        path,
        ok: true,
        value: {
          protocol: "capvine.gmail.read.v1",
          ...binding,
          message: { id: "a42", subject: "Report", snippet: "Ready" },
        },
      },
    },
  };
}

async function endpoint(onCall: (input: unknown) => Record<string, unknown>) {
  const connections: {
    server: Server;
    transport: StreamableHTTPServerTransport;
  }[] = [];
  const http = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer fixture-token") {
      request.resume();
      response.writeHead(401).end();
      return;
    }
    const server = new Server(
      { name: "executor-protocol-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    connections.push({ server, transport });
    server.setRequestHandler(CallToolRequestSchema, async (input) => ({
      content: [],
      structuredContent: onCall(input.params),
    }));
    void server
      .connect(transport as Transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await Promise.all(connections.map(({ server }) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("Executor adapter dispatches only verified exact reads and stops after parent revocation", async (t) => {
  let calls = 0;
  const executor = await endpoint((input) => {
    calls++;
    assert.deepEqual(input, {
      name: "call",
      arguments: { calls: { path, input: binding } },
    });
    return success();
  });
  t.after(() => executor.close());
  const adapter = await createExecutorGmailAdapter({
    url: executor.url,
    token: "fixture-token",
    app: "mail",
    connectionId: "mail",
    ownerId: "owner",
    messages: [{ id: resourceId, ...binding }],
  });
  t.after(() => adapter.close());
  const store = new MemoryStore();
  store.addResource(adapter.resources[0]!);
  store.addTask({ id: "report", ownerId: "owner", active: true });
  const signer = await identity.generate();
  const worker = await identity.generate();
  const child = await identity.generate();
  const authority = createAuthority({
    signer,
    store,
    authorizeGrant: () => true,
  });
  authority.registerOperation(adapter.operations[0]!);
  const grant = await authority.issue({
    actor: "owner",
    audience: worker,
    taskId: "report",
    resource: resourceId,
    action: "gmail/message.read",
    expiresAt: new Date(Date.now() + 120_000),
  });
  const a = createClient({
    signer: worker,
    service: authority.principal,
    transport: authority.execute,
  });
  const delegated = await a.delegate({
    grant,
    audience: child,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const b = createClient({
    signer: child,
    service: authority.principal,
    transport: authority.execute,
  });
  assert.deepEqual(await b.invoke(delegated), {
    id: "a42",
    subject: "Report",
    snippet: "Ready",
  });
  for (const capability of [
    {
      can: "capvine/invoke" as const,
      with: "urn:capvine:resource:other" as const,
      nb: {
        action: "gmail/message.read",
        task: "report",
        service: signer.did(),
      },
    },
    {
      can: "capvine/invoke" as const,
      with: resourceId,
      nb: {
        action: "gmail/message.send",
        task: "report",
        service: signer.did(),
      },
    },
  ]) {
    const forged = await invoke({
      issuer: worker,
      audience: signer,
      capability,
      proofs: [grant],
      expiration: Math.floor(Date.now() / 1000) + 30,
    }).delegate();
    await assert.rejects(
      authority.execute(await encodeGrant(forged)),
      PermissionDenied,
    );
  }
  store.revoke(grant.cid.toString());
  await assert.rejects(b.invoke(delegated), PermissionDenied);
  assert.equal(calls, 1);
  await assert.rejects(
    adapter.operations[0]!.execute({
      ...adapter.resources[0]!,
      target: { ...adapter.resources[0]!.target, accountId: "other" },
    }),
    PermissionDenied,
  );
  assert.equal(calls, 1);
});

test("Executor adapter refuses suspended, mismatched, malformed, and oversized results", async (t) => {
  let response: Record<string, unknown> = success();
  const executor = await endpoint(() => response);
  t.after(() => executor.close());
  const adapter = await createExecutorGmailAdapter({
    url: executor.url,
    token: "fixture-token",
    app: "mail",
    connectionId: "mail",
    ownerId: "owner",
    messages: [{ id: resourceId, ...binding }],
  });
  t.after(() => adapter.close());
  const read = () => adapter.operations[0]!.execute(adapter.resources[0]!);
  for (const malformed of [
    { status: "approval-required", requestId: "secret" },
    {
      status: "completed",
      execution: { ok: false, error: "private-provider-error" },
    },
    {
      ...success(),
      execution: {
        ok: true,
        value: { ...success().execution.value, path: "other" },
      },
    },
    {
      ...success(),
      execution: {
        ok: true,
        value: {
          ...success().execution.value,
          value: { ...success().execution.value.value, accountId: "other" },
        },
      },
    },
    {
      ...success(),
      execution: {
        ok: true,
        value: {
          ...success().execution.value,
          value: { ...success().execution.value.value, subject: "other" },
        },
      },
    },
    { huge: "x".repeat(1_048_577) },
  ]) {
    response = malformed;
    await assert.rejects(read(), { message: "Executor Gmail read failed" });
  }
});

test("Executor companion checks the captured account and provider identity before reading a message", async () => {
  let subject = "subject-a";
  let messageId = "a42";
  let reads = 0;
  const request: typeof fetch = async (url, init) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture-credential",
    );
    assert.equal(init?.redirect, "manual");
    if (String(url).includes("userinfo"))
      return Response.json({ sub: subject });
    reads++;
    return Response.json({
      id: messageId,
      snippet: "Ready",
      payload: { headers: [{ name: "Subject", value: "Report" }] },
    });
  };
  const account = {
    id: "account-a",
    fields: { access_token: "fixture-credential" },
  };
  const result = await readBoundMessage(account, binding, request);
  assert.deepEqual(await inspectAccount(account, request), {
    accountId: "account-a",
    subject: "subject-a",
  });
  assert.equal(result.message.subject, "Report");
  assert.ok(!JSON.stringify(result).includes("fixture-credential"));
  subject = "different-provider-account";
  await assert.rejects(
    readBoundMessage(account, binding, request),
    /identity changed/,
  );
  assert.equal(reads, 1);
  await assert.rejects(
    readBoundMessage({ ...account, id: "other" }, binding, request),
    /binding denied/,
  );
  assert.equal(reads, 1);
  subject = "subject-a";
  messageId = "a43";
  await assert.rejects(
    readBoundMessage(account, binding, request),
    /message mismatch/,
  );
});

test("Executor companion refuses provider redirects and oversized identity responses", async () => {
  const account = { id: "account-a", fields: { access_token: "fixture" } };
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { location: "https://other.example" },
    }),
    new Response("x".repeat(131_073)),
  ]) {
    let calls = 0;
    await assert.rejects(
      readBoundMessage(account, binding, async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, "manual");
        return response;
      }),
    );
    assert.equal(calls, 1);
  }
});
