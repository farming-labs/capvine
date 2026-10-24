import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "@ucanto/client";
import { createCapvine } from "../src/setup.ts";
import { createCapvineClient, CapvineAPIError } from "../src/owner-client.ts";
import {
  gmail,
  filesystem,
  definePlugin,
  postgres,
  slackMessages,
} from "../src/plugins.ts";
import { oidc, google, slack } from "../src/providers.ts";
import {
  createClient,
  identity,
  decodeGrant,
  encodeGrant,
  PermissionDenied,
} from "../src/index.ts";
import { writePrivateFile } from "../src/identity-file.ts";
import { startProviderFixture } from "../examples/accounts/provider-fixture.ts";
import type { ApplicationOptions } from "../src/application.ts";
import { startPostgresFixture } from "../examples/support/postgres.ts";
import { startSlackFixture } from "../examples/slack/provider-fixture.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "capvine-application-"));
  const data = join(root, "data");
  await mkdir(data, { mode: 0o700 });
  await writePrivateFile(join(data, "one.txt"), "Report one");
  await writePrivateFile(join(data, "two.txt"), "Report two");
  const baseURL = "http://127.0.0.1:8795";
  const sessionId = randomBytes(32).toString("base64url");
  const provider = await startProviderFixture({
    redirectUri: `${baseURL}/api/capvine/callback`,
  });
  const { redirectUri: _, ...providerOptions } = provider.providerOptions();
  const options: ApplicationOptions = {
    baseURL,
    storage: { directory: join(root, "state") },
    ownerId: "owner",
    authenticate(request) {
      if (request.headers.get("cookie") === `session=${sessionId}`)
        return { ownerId: "owner", sessionId };
      if (request.headers.get("cookie") === "session=wrong-session")
        return { ownerId: "owner", sessionId: "s".repeat(43) };
      if (request.headers.get("cookie") === "session=another-owner")
        return { ownerId: "other", sessionId };
      return null;
    },
    providers: [oidc(providerOptions)],
    plugins: [
      gmail({ fetch: provider.gmailFetch }),
      filesystem({ id: "reports", root: data }),
    ],
  };
  let app = await createCapvine(options);
  const headers = {
    cookie: `session=${sessionId}`,
    origin: baseURL,
    "x-capvine-request": "1",
    "content-type": "application/json",
  };
  const client = createCapvineClient({
    baseURL,
    fetch: async (input, init) => {
      const request = new Request(String(input), init);
      request.headers.set("cookie", headers.cookie);
      return app.handler(request);
    },
  });
  const raw = (
    route: string,
    body: unknown,
    customHeaders: HeadersInit = headers,
    method = "POST",
  ) =>
    app.handler(
      new Request(`${baseURL}/api/capvine/${route}`, {
        method,
        headers: customHeaders,
        ...(["GET", "HEAD"].includes(method)
          ? {}
          : { body: JSON.stringify(body) }),
      }),
    );
  const transport = async (bytes: Uint8Array) => {
    const response = await app.handler(
      new Request(app.service.invocationURL, {
        method: "POST",
        headers: { "content-type": "application/vnd.ipld.car" },
        body: new Uint8Array(bytes),
      }),
    );
    if (!response.ok) throw new PermissionDenied("Denied");
    return (await response.json()).ok;
  };
  async function connect() {
    const started = await client.connections.connect({
      provider: "google",
      returnTo: "/connections",
    });
    const callback = await provider.authorize(started.url);
    const response = await app.handler(
      new Request(callback, { headers: { cookie: headers.cookie } }),
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${baseURL}/connections`);
    return started.connectionId;
  }
  t.after(async () => {
    await app.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    options,
    provider,
    baseURL,
    headers,
    raw,
    client,
    transport,
    connect,
    get app() {
      return app;
    },
    async restart(next: ApplicationOptions = options) {
      await app.close();
      app = await createCapvine(next);
    },
  };
}

const denied = (status: number) => (error: unknown) =>
  error instanceof CapvineAPIError && error.status === status;

test("an unfinished owner request times out without registering its partial body", async (t) => {
  const f = await fixture(t);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ type: "fs.file", target: { path: "one.txt" } }),
        ),
      );
    },
  });
  const response = await f.app.handler(
    new Request(`${f.baseURL}/api/capvine/resources/register`, {
      method: "POST",
      headers: f.headers,
      body,
      duplex: "half",
    } as RequestInit),
  );
  assert.equal(response.status, 408);
  assert.deepEqual((await f.client.resources.list()).resources, []);
});

test("owner API and direct methods require the authenticated owner and same-origin mutations", async (t) => {
  const f = await fixture(t);
  const input = { type: "fs.file", target: { path: "one.txt" } };
  for (const [headers, status] of [
    [{ ...f.headers, cookie: "" }, 401],
    [{ ...f.headers, cookie: "session=another-owner" }, 403],
    [{ ...f.headers, origin: "https://attacker.example" }, 403],
    [{ ...f.headers, "x-capvine-request": "" }, 403],
    [{ cookie: f.headers.cookie, "content-type": "application/json" }, 403],
    [{ ...f.headers, "sec-fetch-site": "cross-site" }, 403],
    [{ ...f.headers, "sec-fetch-site": "same-site" }, 403],
  ] as const)
    assert.equal(
      (await f.raw("resources/register", input, headers)).status,
      status,
    );
  await assert.rejects(
    f.app.api.resources.register({
      headers: { cookie: f.headers.cookie },
      body: input,
    }),
    denied(403),
  );
  const selected = await f.app.api.resources.register({
    headers: f.headers,
    body: input,
  });
  assert.equal(selected.type, "fs.file");
  assert.equal((await f.client.resources.list()).resources.length, 1);
  assert.equal(
    (await f.raw("resources/register", { ...input, ownerId: "owner" })).status,
    400,
  );
  assert.equal(
    (await f.raw("resources/register", { ...input, id: selected.id })).status,
    400,
  );
  assert.equal(
    (
      await f.raw("resources/register", {
        ...input,
        target: { path: "../one.txt" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.raw("resources/register", {
        ...input,
        target: { path: "one.txt", url: "https://attacker.example" },
      })
    ).status,
    400,
  );
  await symlink(join(f.data, "one.txt"), join(f.data, "link.txt"));
  assert.equal(
    (
      await f.raw("resources/register", {
        ...input,
        target: { path: "link.txt" },
      })
    ).status,
    400,
  );
  const preflight = await f.raw(
    "resources/register",
    null,
    { origin: "https://attacker.example" },
    "OPTIONS",
  );
  assert.equal(preflight.headers.has("access-control-allow-origin"), false);
  assert.equal(
    (await f.raw("resources/list", {}, f.headers, "GET")).status,
    405,
  );
  assert.equal(
    (
      await f.raw("resources/register", {
        type: "fs.file",
        target: { path: "x".repeat(40000) },
      })
    ).status,
    413,
  );
  const bad = await f.app.handler(
    new Request(`${f.baseURL}/api/capvine/resources/register`, {
      method: "POST",
      headers: f.headers,
      body: "{",
    }),
  );
  assert.equal(bad.status, 400);
  assert.deepEqual(
    (await f.client.resources.list()).resources.map((r) => r.id),
    [selected.id],
  );
});

test("OAuth callbacks bind to the owner session and persist connected metadata without secrets", async (t) => {
  const f = await fixture(t);
  for (const returnTo of [
    "https://attacker.example",
    "//attacker.example",
    "/\\attacker.example",
    "/api/capvine/callback",
  ])
    await assert.rejects(
      f.client.connections.connect({ provider: "google", returnTo }),
      denied(400),
    );
  const started = await f.client.connections.connect({
    provider: "google",
    returnTo: "/connections?connected=1",
  });
  const auth = new URL(started.url);
  assert.equal(
    auth.searchParams.get("redirect_uri"),
    `${f.baseURL}/api/capvine/callback`,
  );
  const callback = await f.provider.authorize(started.url);
  assert.equal((await f.app.handler(new Request(callback))).status, 401);
  assert.equal(
    (
      await f.app.handler(
        new Request(callback, { headers: { cookie: "session=another-owner" } }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.app.handler(
        new Request(callback, { headers: { cookie: "session=wrong-session" } }),
      )
    ).status,
    400,
  );
  assert.equal(f.provider.counts.exchanges, 0);
  const response = await f.app.handler(
    new Request(callback, { headers: { cookie: f.headers.cookie } }),
  );
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    `${f.baseURL}/connections?connected=1`,
  );
  assert.equal(
    (
      await f.app.handler(
        new Request(callback, { headers: { cookie: f.headers.cookie } }),
      )
    ).status,
    400,
  );
  const listing = await f.client.connections.list();
  assert.equal(listing.connections[0]?.status, "connected");
  assert.equal(listing.connections[0]?.subject, "fixture-subject");
  for (const secret of f.provider.secrets())
    assert.equal(JSON.stringify(listing).includes(secret), false);
  await f.restart();
  assert.deepEqual(await f.client.connections.list(), listing);
  assert.equal(f.provider.counts.exchanges, 1);
});

test("dynamic Gmail resources preserve exact bindings through delegation, restart and root revocation", async (t) => {
  const f = await fixture(t);
  const connectionId = await f.connect();
  const receipt = await f.client.resources.register({
    type: "gmail.message",
    connectionId,
    target: { messageId: "a42" },
  });
  const invoice = await f.client.resources.register({
    type: "gmail.message",
    connectionId,
    target: { messageId: "b43" },
  });
  const coordinator = await identity.generate();
  const worker = await identity.generate();
  const unrelated = await identity.generate();
  const issued = await f.client.grants.issue({
    resource: receipt.id,
    action: "gmail/message.read",
    audience: coordinator.did(),
    expiresIn: 300,
  });
  const independent = await f.client.grants.issue({
    resource: invoice.id,
    action: "gmail/message.read",
    audience: unrelated.did(),
  });
  const service = { did: () => issued.service as `did:key:${string}` };
  const parent = await decodeGrant(Buffer.from(issued.grant, "base64"));
  const client = createClient({
    signer: coordinator,
    service,
    transport: f.transport,
  });
  const child = await client.delegate({
    grant: parent,
    audience: worker,
    expiresAt: new Date(Date.now() + 60000),
  });
  const childClient = createClient({
    signer: worker,
    service,
    transport: f.transport,
  });
  assert.equal(((await childClient.invoke(child)) as { id: string }).id, "a42");
  const before = f.provider.counts.reads;
  for (const [issuer, audience, capability] of [
    [worker, service, { ...child.capabilities[0]!, with: invoice.id }],
    [unrelated, service, child.capabilities[0]!],
    [
      worker,
      service,
      {
        ...child.capabilities[0]!,
        nb: {
          ...(child.capabilities[0]!.nb as Record<string, unknown>),
          action: "gmail/message.send",
        },
      },
    ],
    [
      worker,
      service,
      {
        ...child.capabilities[0]!,
        nb: {
          ...(child.capabilities[0]!.nb as Record<string, unknown>),
          task: "different-task",
        },
      },
    ],
    [worker, unrelated, child.capabilities[0]!],
  ] as const) {
    const forged = await invoke({
      issuer,
      audience,
      capability,
      proofs: [child],
      expiration: child.expiration,
    }).delegate();
    await assert.rejects(
      f.transport(await encodeGrant(forged)),
      PermissionDenied,
    );
  }
  assert.equal(f.provider.counts.reads, before);
  await f.restart();
  assert.equal(((await childClient.invoke(child)) as { id: string }).id, "a42");
  assert.equal(f.provider.counts.exchanges, 1);
  await f.client.grants.revoke({ id: issued.id });
  await assert.rejects(childClient.invoke(child), PermissionDenied);
  const other = createClient({
    signer: unrelated,
    service,
    transport: f.transport,
  });
  assert.equal(
    (
      (await other.invoke(
        await decodeGrant(Buffer.from(independent.grant, "base64")),
      )) as { id: string }
    ).id,
    "b43",
  );
  await f.restart();
  await assert.rejects(childClient.invoke(child), PermissionDenied);
  await f.client.connections.disconnect({ connectionId });
  await assert.rejects(
    other.invoke(await decodeGrant(Buffer.from(independent.grant, "base64"))),
    PermissionDenied,
  );
  await assert.rejects(
    f.client.grants.issue({
      resource: invoice.id,
      action: "gmail/message.read",
      audience: unrelated.did(),
    }),
    denied(403),
  );
  await f.restart();
  assert.equal(
    (await f.client.connections.list()).connections[0]?.status,
    "disconnected",
  );
  await assert.rejects(
    other.invoke(await decodeGrant(Buffer.from(independent.grant, "base64"))),
    PermissionDenied,
  );
  for (const secret of f.provider.secrets())
    assert.equal(JSON.stringify(issued).includes(secret), false);
});

test("registration does not authorize workers and rejects unowned accounts, unknown actions and expanded requests", async (t) => {
  const f = await fixture(t);
  const worker = await identity.generate();
  const connectionId = await f.connect();
  for (const input of [
    {
      type: "gmail.message",
      connectionId: "not-owned",
      target: { messageId: "a42" },
    },
    {
      type: "gmail.message",
      connectionId,
      target: { messageId: "a42", subject: "other" },
    },
    {
      type: "gmail.message",
      connectionId,
      target: { messageId: "https://attacker.example" },
    },
    {
      type: "gmail.message",
      connectionId,
      target: { messageId: "a42" },
      subject: "other",
    },
    { type: "fs.file", connectionId, target: { path: "one.txt" } },
  ])
    assert.equal((await f.raw("resources/register", input)).status, 400);
  const selected = await f.client.resources.register({
    type: "fs.file",
    target: { path: "one.txt" },
  });
  const input = {
    resource: selected.id,
    action: "fs/read",
    audience: worker.did(),
  };
  for (const body of [
    { ...input, action: "fs/write" },
    { ...input, resource: "urn:capvine:resource:absent" },
  ])
    assert.equal((await f.raw("grants/issue", body)).status, 403);
  for (const body of [
    { ...input, expiresIn: 3601 },
    { ...input, expiresIn: 0 },
    { ...input, audience: "agent-name" },
    { ...input, ownerId: "owner" },
    { ...input, task: "chosen-task" },
  ])
    assert.equal((await f.raw("grants/issue", body)).status, 400);
  const issued = await f.client.grants.issue(input);
  assert.equal(
    (
      await f.raw("grants/issue", input, {
        ...f.headers,
        cookie: "",
        authorization: `Bearer ${issued.grant}`,
      })
    ).status,
    401,
  );
  const root = await decodeGrant(Buffer.from(issued.grant, "base64"));
  const bare = await invoke({
    issuer: worker,
    audience: { did: () => issued.service as `did:key:${string}` },
    capability: root.capabilities[0]!,
    expiration: root.expiration,
  }).delegate();
  await assert.rejects(f.transport(await encodeGrant(bare)), PermissionDenied);
  assert.equal(f.provider.counts.reads, 0);
});

test("persistent files cannot be retargeted by path replacement or a changed plugin configuration", async (t) => {
  const f = await fixture(t);
  const resource = await f.client.resources.register({
    type: "fs.file",
    target: { path: "one.txt" },
  });
  const worker = await identity.generate();
  const issued = await f.client.grants.issue({
    resource: resource.id,
    action: "fs/read",
    audience: worker.did(),
  });
  const grant = await decodeGrant(Buffer.from(issued.grant, "base64"));
  const client = createClient({
    signer: worker,
    service: { did: () => issued.service as `did:key:${string}` },
    transport: f.transport,
  });
  assert.equal(await client.invoke(grant), "Report one");
  await f.restart({
    ...f.options,
    plugins: [gmail({ fetch: f.provider.gmailFetch })],
  });
  await assert.rejects(client.invoke(grant), PermissionDenied);
  await f.restart({
    ...f.options,
    plugins: [filesystem({ id: "reports", root: f.data, maxBytes: 1000 })],
  });
  await assert.rejects(client.invoke(grant), PermissionDenied);
  await f.restart();
  assert.equal(await client.invoke(grant), "Report one");
  await rename(join(f.data, "one.txt"), join(f.data, "old.txt"));
  await writePrivateFile(join(f.data, "one.txt"), "Replacement file");
  assert.equal(await client.invoke(grant), "Report one");
  await f.restart();
  await assert.rejects(client.invoke(grant), PermissionDenied);
  const replacement = await f.client.resources.register({
    type: "fs.file",
    target: { path: "one.txt" },
  });
  assert.notEqual(replacement.id, resource.id);
});

test("setup pins origin, rejects concurrent stores, and infers provider callbacks", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createCapvine(f.options), /EEXIST/);
  await f.app.close();
  await assert.rejects(
    createCapvine({ ...f.options, baseURL: "http://127.0.0.1:9999" }),
    /another origin/,
  );
  await f.restart();
  const definition = google({
    clientId: "example",
    clientSecret: "example-secret",
  });
  const provider = definition.create(f.app.service.callbackURL);
  const url = new URL(
    await provider.authorizationUrl({
      state: "state",
      verifier: "v".repeat(43),
      nonce: "nonce",
    }),
  );
  assert.equal(url.searchParams.get("redirect_uri"), f.app.service.callbackURL);
  const slackProvider = slack({
    clientId: "123.456",
    appId: "A123",
    scopes: ["channels:history"],
  }).create(f.app.service.callbackURL);
  const slackURL = new URL(
    await slackProvider.authorizationUrl({
      state: "state",
      verifier: "v".repeat(43),
      nonce: "nonce",
    }),
  );
  assert.equal(
    slackURL.searchParams.get("redirect_uri"),
    f.app.service.callbackURL,
  );
});

test("custom plugins cannot register different resources and shutdown drains pending registration", async (t) => {
  const f = await fixture(t);
  let released!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    released = resolve;
  });
  let closes = 0;
  const plugin = definePlugin({
    id: "custom",
    type: "custom.item",
    configuration: "v1",
    actions: ["custom/read"],
    async open({ id, ownerId }) {
      entered();
      await pause;
      return {
        resources: [
          { id, ownerId, kind: "custom.item", target: { fixed: "one" } },
        ],
        operations: [
          {
            action: "custom/read",
            resourceKind: "custom.item",
            async execute() {
              return "one";
            },
          },
        ],
        async close() {
          closes++;
        },
      };
    },
  });
  await f.restart({ ...f.options, plugins: [plugin] });
  const registering = f.client.resources.register({
    type: "custom.item",
    target: {},
  });
  await waiting;
  let stopped = false;
  const closing = f.app.close().then(() => {
    stopped = true;
  });
  assert.equal((await f.raw("resources/list", {})).status, 503);
  assert.equal(stopped, false);
  released();
  await registering;
  await closing;
  assert.equal(closes, 1);
  const malformed = definePlugin({
    ...plugin,
    async open(context) {
      const adapter = await plugin.open(context);
      adapter.resources[0]!.ownerId = "other";
      return adapter;
    },
  });
  await f.restart({ ...f.options, plugins: [malformed] });
  await assert.rejects(
    f.client.resources.register({ type: "custom.item", target: {} }),
    denied(400),
  );
  assert.equal(closes, 2);
  assert.equal((await f.client.resources.list()).resources.length, 1);
});

test("runtime PostgreSQL registration preserves table, tenant and projection through restart", async (t) => {
  const database = await startPostgresFixture();
  t.after(() => database.stop());
  const f = await fixture(t);
  const options = {
    ...f.options,
    plugins: [
      postgres({
        id: "records",
        databaseId: "fixture-database",
        connection: database.connection,
      }),
    ],
  };
  await f.restart(options);
  const target = {
    schema: "app",
    table: "records",
    key: { column: "id", value: "one" },
    tenant: { column: "tenant", value: "team-a" },
    columns: ["id", "title"],
  };
  const resource = await f.client.resources.register({
    type: "pg.record",
    target,
  });
  const other = await f.client.resources.register({
    type: "pg.record",
    target: { ...target, tenant: { ...target.tenant, value: "team-b" } },
  });
  const signer = await identity.generate();
  const issued = await f.client.grants.issue({
    resource: resource.id,
    action: "pg/record.read",
    audience: signer.did(),
  });
  const service = { did: () => issued.service as `did:key:${string}` };
  const grant = await decodeGrant(Buffer.from(issued.grant, "base64"));
  const client = createClient({ signer, service, transport: f.transport });
  assert.deepEqual(await client.invoke(grant), {
    id: "one",
    title: "Allowed record",
  });
  const forged = await invoke({
    issuer: signer,
    audience: service,
    capability: { ...grant.capabilities[0]!, with: other.id },
    proofs: [grant],
    expiration: grant.expiration,
  }).delegate();
  await assert.rejects(
    f.transport(await encodeGrant(forged)),
    PermissionDenied,
  );
  await assert.rejects(
    f.client.resources.register({
      type: "pg.record",
      target: { ...target, query: "SELECT * FROM app.records" },
    }),
    denied(400),
  );
  await f.restart(options);
  assert.deepEqual(await client.invoke(grant), {
    id: "one",
    title: "Allowed record",
  });
  await f.client.grants.revoke({ id: issued.id });
  await assert.rejects(client.invoke(grant), PermissionDenied);
});

test("runtime Slack registration resolves account identity and denies access after disconnect", async (t) => {
  const f = await fixture(t);
  const provider = await startSlackFixture({
    redirectUri: f.app.service.callbackURL,
  });
  t.after(() => provider.close());
  const options = {
    ...f.options,
    providers: [
      slack({
        clientId: "123.456",
        appId: "AFIXTURE",
        scopes: ["channels:history"],
        fetch: provider.fetch,
      }),
    ],
    plugins: [slackMessages({ fetch: provider.fetch })],
  };
  await f.restart(options);
  const pending = await f.client.connections.connect({ provider: "slack" });
  const callback = await provider.authorize(pending.url);
  assert.equal(
    (
      await f.app.handler(
        new Request(callback, { headers: { cookie: f.headers.cookie } }),
      )
    ).status,
    303,
  );
  const resource = await f.client.resources.register({
    type: "slack.message",
    connectionId: pending.connectionId,
    target: { channelId: "CFIXTURE", timestamp: "1700000000.000042" },
  });
  const signer = await identity.generate();
  const issued = await f.client.grants.issue({
    resource: resource.id,
    action: "slack/message.read",
    audience: signer.did(),
  });
  const client = createClient({
    signer,
    service: { did: () => issued.service as `did:key:${string}` },
    transport: f.transport,
  });
  const grant = await decodeGrant(Buffer.from(issued.grant, "base64"));
  assert.deepEqual(await client.invoke(grant), {
    channelId: "CFIXTURE",
    timestamp: "1700000000.000042",
    text: "The fixture report is ready.",
  });
  await f.restart(options);
  assert.equal(
    ((await client.invoke(grant)) as { timestamp: string }).timestamp,
    "1700000000.000042",
  );
  await f.client.connections.disconnect({ connectionId: pending.connectionId });
  await assert.rejects(client.invoke(grant), PermissionDenied);
});

test("multiple instances require an explicit plugin selection and paginated listings retain all registered resources", async (t) => {
  const f = await fixture(t);
  await f.restart({
    ...f.options,
    plugins: [
      filesystem({ id: "first", root: f.data }),
      filesystem({ id: "second", root: f.data }),
    ],
  });
  await assert.rejects(
    f.client.resources.register({
      type: "fs.file",
      target: { path: "one.txt" },
    }),
    denied(400),
  );
  const ids: string[] = [];
  for (let i = 0; i < 26; i++)
    ids.push(
      (
        await f.client.resources.register({
          type: "fs.file",
          plugin: "second",
          target: { path: "one.txt" },
        })
      ).id,
    );
  const first = await f.client.resources.list();
  assert.equal(first.resources.length, 25);
  assert.ok(first.nextCursor);
  const second = await f.client.resources.list({ after: first.nextCursor });
  assert.equal(second.resources.length, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.resources, ...second.resources].map((r) => r.id).sort(),
    ids.sort(),
  );
});

test("saved application approvals renew the same scope and disable every descendant across restart", async (t) => {
  const f = await fixture(t);
  const connectionId = await f.connect();
  const selected = await f.client.resources.register({
    type: "gmail.message",
    connectionId,
    target: { messageId: "a42" },
  });
  const coordinator = await identity.generate();
  const worker = await identity.generate();
  const saved = await f.client.workflows.approve({
    resource: selected.id,
    action: "gmail/message.read",
    audience: coordinator.did(),
    expiresIn: 600,
    maxGrantSeconds: 120,
  });
  assert.equal(saved.active, true);
  const original = await f.client.workflows.issue({ id: saved.id });
  assert.ok(original.expiresAt <= saved.expiresAt);
  assert.ok(original.expiresAt <= Math.floor(Date.now() / 1000) + 120);
  const parent = await decodeGrant(Buffer.from(original.grant, "base64"));
  const client = createClient({
    signer: coordinator,
    service: identity.Verifier.parse(original.service),
    transport: f.transport,
  });
  const child = await client.delegate({
    grant: parent,
    audience: worker,
    expiresAt: new Date(Date.now() + 60000),
  });
  const childClient = createClient({
    signer: worker,
    service: identity.Verifier.parse(original.service),
    transport: f.transport,
  });
  assert.equal(((await childClient.invoke(child)) as { id: string }).id, "a42");
  await f.restart();
  assert.deepEqual((await f.client.workflows.list()).workflows, [saved]);
  const renewed = await f.app.api.workflows.issue({
    headers: f.headers,
    body: { id: saved.id },
  });
  const fresh = await decodeGrant(Buffer.from(renewed.grant, "base64"));
  assert.deepEqual(fresh.capabilities, parent.capabilities);
  assert.equal(fresh.audience.did(), parent.audience.did());
  assert.equal(((await client.invoke(fresh)) as { id: string }).id, "a42");
  const raw = await invoke({
    issuer: worker,
    audience: identity.Verifier.parse(original.service),
    capability: {
      ...child.capabilities[0]!,
      nb: {
        ...(child.capabilities[0]!.nb as Record<string, unknown>),
        action: "gmail/message.send",
      },
    },
    proofs: [child],
  }).delegate();
  const reads = f.provider.counts.reads;
  await assert.rejects(f.transport(await encodeGrant(raw)), PermissionDenied);
  await f.client.workflows.disable({ id: saved.id });
  await assert.rejects(childClient.invoke(child), PermissionDenied);
  await assert.rejects(client.invoke(fresh), PermissionDenied);
  await assert.rejects(f.client.workflows.issue({ id: saved.id }), denied(403));
  assert.equal(f.provider.counts.reads, reads);
  await f.restart();
  assert.equal((await f.client.workflows.list()).workflows[0]?.active, false);
  await assert.rejects(f.client.workflows.issue({ id: saved.id }), denied(403));
  await assert.rejects(childClient.invoke(child), PermissionDenied);
});

test("workflow renewal cannot change scope or bypass owner authentication and provider disconnection", async (t) => {
  const f = await fixture(t);
  const connectionId = await f.connect();
  const selected = await f.client.resources.register({
    type: "gmail.message",
    connectionId,
    target: { messageId: "a42" },
  });
  const signer = await identity.generate();
  const input = {
    resource: selected.id,
    action: "gmail/message.read",
    audience: signer.did(),
    expiresIn: 300,
  };
  for (const expiresIn of [0, -1, 0.5, 2592001])
    await assert.rejects(
      f.client.workflows.approve({ ...input, expiresIn }),
      denied(400),
    );
  await assert.rejects(
    f.client.workflows.approve({ ...input, maxGrantSeconds: 3601 }),
    denied(400),
  );
  await assert.rejects(
    f.client.workflows.approve({ ...input, action: "gmail/message.send" }),
    denied(403),
  );
  const saved = await f.client.workflows.approve(input);
  for (const route of ["workflows/issue", "workflows/disable"]) {
    assert.equal(
      (await f.raw(route, { id: saved.id }, { ...f.headers, cookie: "" }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.raw(
          route,
          { id: saved.id },
          { ...f.headers, cookie: "session=another-owner" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.raw(
          route,
          { id: saved.id },
          { ...f.headers, origin: "https://attacker.example" },
        )
      ).status,
      403,
    );
  }
  for (const extra of [
    { audience: (await identity.generate()).did() },
    { resource: "urn:capvine:resource:other" },
    { action: "gmail/message.send" },
    { expiresIn: 9999 },
  ])
    assert.equal(
      (await f.raw("workflows/issue", { id: saved.id, ...extra })).status,
      400,
    );
  await f.client.connections.disconnect({ connectionId });
  await assert.rejects(f.client.workflows.issue({ id: saved.id }), denied(403));
  await f.restart();
  await assert.rejects(f.client.workflows.issue({ id: saved.id }), denied(403));
});

test("automatic renewal delivers fresh grants serially and stops on disable, abort, or delivery failure", async (t) => {
  const f = await fixture(t);
  const selected = await f.client.resources.register({
    type: "fs.file",
    target: { path: "one.txt" },
  });
  const signer = await identity.generate();
  const saved = await f.client.workflows.approve({
    resource: selected.id,
    action: "fs/read",
    audience: signer.did(),
    expiresIn: 60,
    maxGrantSeconds: 4,
  });
  const abort = new AbortController();
  const delivered: string[] = [];
  await assert.rejects(
    f.client.workflows.maintain({
      id: saved.id,
      signal: abort.signal,
      async onGrant(grant) {
        const proof = await decodeGrant(Buffer.from(grant.grant, "base64"));
        const worker = createClient({
          signer,
          service: identity.Verifier.parse(grant.service),
          transport: f.transport,
        });
        assert.equal(await worker.invoke(proof), "Report one");
        delivered.push(grant.id);
        if (delivered.length === 2)
          await f.client.workflows.disable({ id: saved.id });
      },
    }),
    denied(403),
  );
  assert.equal(new Set(delivered).size, 2);
  abort.abort();
  await f.client.workflows.maintain({
    id: "unknown",
    signal: abort.signal,
    onGrant() {
      assert.fail("Aborted renewal delivered a grant");
    },
  });
  const active = await f.client.workflows.approve({
    resource: selected.id,
    action: "fs/read",
    audience: signer.did(),
    expiresIn: 60,
  });
  await assert.rejects(
    f.client.workflows.maintain({
      id: active.id,
      signal: new AbortController().signal,
      onGrant() {
        throw new Error("Delivery failed");
      },
    }),
    /Delivery failed/,
  );
  const stop = new AbortController();
  let count = 0;
  await f.client.workflows.maintain({
    id: active.id,
    signal: stop.signal,
    onGrant() {
      count++;
      stop.abort();
    },
  });
  assert.equal(count, 1);
});
