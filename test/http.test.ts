import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import {
  createAuthority,
  createClient,
  identity,
  MemoryStore,
  PermissionDenied,
} from "../src/index.ts";
import {
  createHttpHandler,
  createHttpTransport,
  HttpTransportError,
} from "../src/http.ts";

const headers = { "content-type": "application/vnd.ipld.car" };

async function listen(
  t: TestContext,
  handler: RequestListener,
): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/invoke`;
}

test("HTTP transports a signed invocation and reports revocation as PermissionDenied", async (t) => {
  const service = await identity.generate();
  const worker = await identity.generate();
  const store = new MemoryStore();
  let calls = 0;
  store.addTask({ id: "task", ownerId: "owner", active: true });
  store.addResource({
    id: "urn:capvine:resource:42",
    ownerId: "owner",
    kind: "issue",
    target: { id: "42" },
  });
  const authority = createAuthority({
    signer: service,
    store,
    authorizeGrant: ({ actor }) => actor === "owner",
  });
  authority.registerOperation({
    action: "issue/read",
    resourceKind: "issue",
    execute: async (resource) => {
      calls++;
      return resource.target.id!;
    },
  });
  const url = await listen(
    t,
    createHttpHandler({ execute: authority.execute }),
  );
  const client = createClient({
    signer: worker,
    service: authority.principal,
    transport: createHttpTransport({ url }),
  });
  const grant = await authority.issue({
    actor: "owner",
    audience: worker,
    taskId: "task",
    resource: "urn:capvine:resource:42",
    action: "issue/read",
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(await client.invoke(grant), "42");
  store.revoke(grant.cid.toString());
  await assert.rejects(client.invoke(grant), PermissionDenied);
  assert.equal(calls, 1);
  const malformed = await fetch(url, {
    method: "POST",
    headers,
    body: "not a proof archive",
  });
  assert.equal(malformed.status, 403);
  assert.deepEqual(await malformed.json(), { error: "permission_denied" });
  assert.equal(calls, 1);
});

test("worker HTTP surface exposes invocation only and refuses browser origins", async (t) => {
  let calls = 0;
  const url = await listen(
    t,
    createHttpHandler({
      execute: async () => {
        calls++;
        return null;
      },
    }),
  );
  for (const [target, init, expected] of [
    [new URL("/admin/issue", url), { method: "POST" }, 404],
    [url, { method: "GET" }, 405],
    [
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      415,
    ],
    [
      url,
      {
        method: "POST",
        headers: { ...headers, origin: "https://untrusted.example" },
        body: "x",
      },
      403,
    ],
  ] as const) {
    const response = await fetch(target, init);
    assert.equal(response.status, expected);
    await response.body?.cancel();
  }
  assert.equal(calls, 0);
});

test("oversized requests with content-length never reach the verifier", async (t) => {
  let calls = 0;
  const url = await listen(
    t,
    createHttpHandler({
      execute: async () => {
        calls++;
        return null;
      },
    }),
  );
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: new Uint8Array(65_537),
  });
  assert.equal(response.status, 413);
  await response.body?.cancel();
  assert.equal(calls, 0);
});

test("chunked requests cannot evade the byte limit", async (t) => {
  let calls = 0;
  const url = await listen(
    t,
    createHttpHandler({
      execute: async () => {
        calls++;
        return null;
      },
    }),
  );
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(url, { method: "POST", headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject);
    outgoing.write(new Uint8Array(40_000));
    outgoing.end(new Uint8Array(40_000));
  });
  assert.equal(status, 413);
  assert.equal(calls, 0);
});

test("unexpected server failures do not expose error details", async (t) => {
  const url = await listen(
    t,
    createHttpHandler({
      execute: async () => {
        throw new Error("PRIVATE_PROVIDER_SECRET");
      },
    }),
  );
  const response = await fetch(url, { method: "POST", headers, body: "x" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "request_failed" });
  await assert.rejects(
    createHttpTransport({ url })(new Uint8Array([1])),
    (error: unknown) =>
      error instanceof HttpTransportError && error.status === 500,
  );
});

test("oversized tool results are not returned", async (t) => {
  const url = await listen(
    t,
    createHttpHandler({ execute: async () => "x".repeat(1_048_577) }),
  );
  const response = await fetch(url, { method: "POST", headers, body: "x" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "result_too_large" });
});

test("client rejects oversized responses from an untrusted endpoint", async (t) => {
  const url = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":"');
    response.end(`${"x".repeat(1_048_700)}"}`);
  });
  await assert.rejects(
    createHttpTransport({ url })(new Uint8Array([1])),
    /too large/,
  );
});

test("client never follows a redirect with a signed invocation", async (t) => {
  let forwarded = 0;
  const target = await listen(t, (_request, response) => {
    forwarded++;
    response.end('{"ok":null}');
  });
  const redirect = await listen(t, (_request, response) =>
    response.writeHead(307, { location: target }).end(),
  );
  await assert.rejects(
    createHttpTransport({ url: redirect })(new Uint8Array([1])),
  );
  assert.equal(forwarded, 0);
});

test("client requires TLS outside loopback and validates timeout configuration", () => {
  for (const url of [
    "http://example.com/invoke",
    "file:///tmp/invoke",
    "http://user:secret@localhost/invoke",
    "http://localhost/invoke#fragment",
  ])
    assert.throws(() => createHttpTransport({ url }));
  assert.throws(() =>
    createHttpTransport({ url: "http://localhost/invoke", timeoutMs: 0 }),
  );
});

test("concurrent invocations beyond the per-handler limit receive backpressure", async (t) => {
  let release!: () => void;
  let reachedLimit!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const full = new Promise<void>((resolve) => {
    reachedLimit = resolve;
  });
  let calls = 0;
  const url = await listen(
    t,
    createHttpHandler({
      execute: async () => {
        if (++calls === 16) reachedLimit();
        await pending;
        return null;
      },
    }),
  );
  const transport = createHttpTransport({ url });
  const requests = Array.from({ length: 16 }, () =>
    transport(new Uint8Array([1])),
  );
  try {
    await full;
    await assert.rejects(
      transport(new Uint8Array([1])),
      (error: unknown) =>
        error instanceof HttpTransportError && error.status === 429,
    );
    assert.equal(calls, 16);
  } finally {
    release();
    await Promise.all(requests);
  }
});
