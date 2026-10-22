import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invoke } from "@ucanto/client";
import { openAccountManager } from "../src/accounts.ts";
import { createSlackAdapter, createSlackProvider } from "../src/slack.ts";
import {
  createAuthority,
  createClient,
  encodeGrant,
  identity,
  MemoryStore,
  PermissionDenied,
} from "../src/index.ts";
import { startSlackFixture } from "../examples/slack/provider-fixture.ts";

async function setup(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), "capvine-slack-test-"));
  const provider = await startSlackFixture();
  const options = {
    directory: join(temporary, "accounts"),
    key: randomBytes(32),
    providers: [provider.provider()],
  };
  let accounts = await openAccountManager(options);
  t.after(async () => {
    await accounts.close();
    await provider.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const sessionId = randomBytes(32).toString("base64url");
  const begin = (connectionId = "slack") =>
    accounts.begin({
      ownerId: "owner",
      sessionId,
      connectionId,
      provider: "slack",
    });
  const complete = (callback: URL) =>
    accounts.complete({ ownerId: "owner", sessionId, callback });
  const use = (
    call: (token: string) => Promise<unknown> = async () => "allowed",
  ) =>
    accounts.withAccessToken(
      {
        ownerId: "owner",
        connectionId: "slack",
        provider: "slack",
        subject: "slack:TFIXTURE:UFIXTURE",
      },
      call,
    );
  const message = {
    id: "urn:capvine:resource:slack-message" as const,
    connectionId: "slack",
    subject: "slack:TFIXTURE:UFIXTURE",
    channelId: "CFIXTURE",
    timestamp: "1700000000.000042",
  };
  return {
    provider,
    options,
    begin,
    complete,
    use,
    message,
    accounts: () => accounts,
    connect: async () =>
      complete(await provider.authorize((await begin()).url)),
    adapter: () =>
      createSlackAdapter({
        accounts,
        ownerId: "owner",
        messages: [message],
        fetch: provider.fetch,
      }),
    restart: async () => {
      await accounts.close();
      accounts = await openAccountManager(options);
    },
  };
}

test("Slack PKCE exchange and serialized user-token rotation persist encrypted across restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date() });
  const f = await setup(t);
  const connected = await f.connect();
  assert.equal(connected.subject, "slack:TFIXTURE:UFIXTURE");
  assert.equal(connected.status, "connected");
  assert.deepEqual(await Promise.all([f.use(), f.use(), f.use()]), [
    "allowed",
    "allowed",
    "allowed",
  ]);
  assert.equal(f.provider.counts.exchanges, 1);
  assert.equal(f.provider.counts.refreshes, 1);
  await f.restart();
  t.mock.timers.tick(3_600_001);
  assert.equal(await f.use(), "allowed");
  assert.equal(f.provider.counts.refreshes, 2);
  const encrypted = await readFile(join(f.options.directory, "accounts.db"));
  for (const secret of f.provider.secrets()) {
    assert.equal(encrypted.includes(Buffer.from(secret)), false);
    assert.equal(JSON.stringify(connected).includes(secret), false);
  }
});

test("Slack authorization codes cannot be swapped between PKCE flows or sent to another callback", async (t) => {
  const f = await setup(t);
  const a = await f.provider.authorize((await f.begin()).url);
  const b = await f.provider.authorize((await f.begin("other")).url);
  const swapped = new URL(a);
  swapped.searchParams.set("code", b.searchParams.get("code")!);
  await assert.rejects(f.complete(swapped));
  const otherOrigin = new URL(b);
  otherOrigin.hostname = "localhost";
  await assert.rejects(f.complete(otherOrigin));
  assert.equal(f.provider.counts.exchanges, 0);
  await assert.rejects(f.use());
});

for (const change of [
  { tokenType: "bot" },
  { appId: "AOTHER" },
  { teamId: "TOTHER" },
  { scope: "" },
  { scope: "channels:history,chat:write" },
  { omitRefresh: true },
  { enterpriseInstall: true },
  { authUserId: "UOTHER" },
  { authBot: true },
] as const) {
  test(`Slack rejects incompatible account credentials: ${JSON.stringify(change)}`, async (t) => {
    const f = await setup(t);
    Object.assign(f.provider.controls, change);
    await assert.rejects(f.connect(), /Account connection failed/);
    await assert.rejects(f.use());
    assert.equal(f.provider.counts.reads, 0);
    assert.equal(f.accounts().inspect("owner", "slack").status, "connecting");
  });
}

for (const shortAccess of [false, true]) {
  test(`Slack revoked credentials require a fresh connection (refresh needed: ${shortAccess})`, async (t) => {
    const f = await setup(t);
    f.provider.controls.shortAccess = shortAccess;
    await f.connect();
    f.provider.revoke();
    let used = false;
    await assert.rejects(
      f.use(async () => {
        used = true;
      }),
    );
    assert.equal(used, false);
    assert.equal(
      f.accounts().inspect("owner", "slack").status,
      "reconnect_required",
    );
    const counts = { ...f.provider.counts };
    await f.restart();
    await assert.rejects(f.use());
    assert.deepEqual(f.provider.counts, counts);
    const current = await f.complete(
      await f.provider.authorize((await f.begin("new")).url),
    );
    assert.equal(current.status, "connected");
    await assert.rejects(f.use());
  });
}

for (const change of [
  { scope: "" },
  { appId: "AOTHER" },
  { teamId: "TOTHER" },
  { authUserId: "UOTHER" },
  { omitRefresh: true },
] as const) {
  test(`Slack refresh refuses changed account binding: ${JSON.stringify(change)}`, async (t) => {
    const f = await setup(t);
    await f.connect();
    Object.assign(f.provider.controls, change);
    let used = false;
    await assert.rejects(
      f.use(async () => {
        used = true;
      }),
    );
    assert.equal(used, false);
    assert.equal(
      f.accounts().inspect("owner", "slack").status,
      "reconnect_required",
    );
  });
}

test("Slack transient failures block access without clearing credentials or following redirects", async (t) => {
  const f = await setup(t);
  f.provider.controls.shortAccess = false;
  await f.connect();
  for (const status of [429, 503]) {
    f.provider.controls.authStatus = status;
    await assert.rejects(f.use());
    assert.equal(f.accounts().inspect("owner", "slack").status, "connected");
  }
  f.provider.controls.authStatus = 200;
  f.provider.controls.authError = "internal_error";
  await assert.rejects(f.use());
  f.provider.controls.authError = "";
  f.provider.controls.redirect = true;
  await assert.rejects(f.use());
  f.provider.controls.redirect = false;
  await f.restart();
  assert.equal(await f.use(), "allowed");
});

test("Slack disconnect during refresh cannot resurrect credentials", async (t) => {
  const f = await setup(t);
  await f.connect();
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  f.provider.controls.beforeRefresh = async () => {
    reached();
    await blocked;
  };
  let used = false;
  const result = assert.rejects(
    f.use(async () => {
      used = true;
    }),
  );
  await started;
  f.accounts().disconnect("owner", "slack");
  release();
  await result;
  await f.restart();
  assert.equal(used, false);
  assert.equal(f.accounts().inspect("owner", "slack").status, "disconnected");
});

test("delegated Slack reads pin the actual channel and timestamp and reject raw escalation before provider access", async (t) => {
  const f = await setup(t);
  await f.connect();
  const adapter = f.adapter();
  const store = new MemoryStore();
  store.addResource(adapter.resources[0]!);
  store.addTask({ id: "job", ownerId: "owner", active: true });
  const signer = await identity.generate();
  const coordinator = await identity.generate();
  const worker = await identity.generate();
  const authority = createAuthority({
    signer,
    store,
    authorizeGrant: ({ actor }) => actor === "owner",
  });
  authority.registerOperation(adapter.operations[0]!);
  const grant = await authority.issue({
    actor: "owner",
    audience: coordinator,
    resource: f.message.id,
    action: "slack/message.read",
    taskId: "job",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const client = createClient({
    signer: coordinator,
    service: signer,
    transport: authority.execute,
  });
  const child = await client.delegate({
    grant,
    audience: worker,
    expiresAt: new Date(Date.now() + 30_000),
  });
  const workerClient = createClient({
    signer: worker,
    service: signer,
    transport: authority.execute,
  });
  assert.deepEqual(await workerClient.invoke(child), {
    channelId: "CFIXTURE",
    timestamp: "1700000000.000042",
    text: "The fixture report is ready.",
  });
  assert.deepEqual(f.provider.reads, [
    {
      channel: "CFIXTURE",
      oldest: "1700000000.000042",
      latest: "1700000000.000042",
      inclusive: "true",
      limit: "1",
    },
  ]);
  const before = { ...f.provider.counts };
  for (const change of [
    { with: "urn:capvine:resource:other" as const },
    { nb: { ...child.capabilities[0]!.nb!, action: "slack/message.write" } },
    { nb: { ...child.capabilities[0]!.nb!, task: "another-job" } },
  ]) {
    const forged = await invoke({
      issuer: worker,
      audience: signer,
      proofs: [child],
      capability: { ...child.capabilities[0]!, ...change },
      expiration: child.expiration,
    }).delegate();
    await assert.rejects(
      authority.execute(await encodeGrant(forged)),
      PermissionDenied,
    );
  }
  for (const target of [
    { channelId: "COTHER" },
    { timestamp: "1700000000.000043" },
    { connectionId: "another" },
    { subject: "slack:TOTHER:UFIXTURE" },
  ])
    await assert.rejects(
      adapter.operations[0]!.execute({
        ...adapter.resources[0]!,
        target: { ...adapter.resources[0]!.target, ...target },
      }),
      PermissionDenied,
    );
  assert.deepEqual(f.provider.counts, before);
  f.provider.revoke();
  await assert.rejects(workerClient.invoke(child), /Slack read failed/);
  await f.complete(await f.provider.authorize((await f.begin("new")).url));
  await assert.rejects(workerClient.invoke(child), /Slack read failed/);
  store.revoke(grant.cid.toString());
  await assert.rejects(workerClient.invoke(child), PermissionDenied);
  assert.equal(f.provider.counts.reads, 1);
});

test("Slack message reads reject unexpected targets, excess results, oversized text and provider errors", async (t) => {
  const f = await setup(t);
  await f.connect();
  const adapter = f.adapter();
  for (const flag of [
    "wrongTimestamp",
    "extraMessage",
    "emptyMessages",
    "oversized",
    "redirect",
  ] as const) {
    f.provider.controls[flag] = true;
    await assert.rejects(
      adapter.operations[0]!.execute(adapter.resources[0]!),
      /Slack read failed/,
    );
    f.provider.controls[flag] = false;
  }
  f.provider.controls.historyError = "missing_scope";
  await assert.rejects(
    adapter.operations[0]!.execute(adapter.resources[0]!),
    /Slack read failed/,
  );
  f.provider.controls.historyError = "";
  f.provider.controls.historyStatus = 429;
  await assert.rejects(
    adapter.operations[0]!.execute(adapter.resources[0]!),
    /Slack read failed/,
  );
  f.provider.controls.historyStatus = 200;
  assert.equal(
    (
      (await adapter.operations[0]!.execute(adapter.resources[0]!)) as {
        text: string;
      }
    ).text,
    "The fixture report is ready.",
  );
  for (const channelId of [
    "../CFIXTURE",
    "CFIXTURE?token=secret",
    "https://other.example",
  ])
    assert.throws(() =>
      createSlackAdapter({
        accounts: f.accounts(),
        ownerId: "owner",
        messages: [{ ...f.message, channelId }],
      }),
    );
});

test("Slack provider configuration fixes the OAuth app, callback and requested read scopes", () => {
  const config = {
    clientId: "123.456",
    appId: "AFIXTURE",
    redirectUri: "http://127.0.0.1:8787/oauth/callback",
    scopes: ["channels:history" as const],
  };
  const baseline = createSlackProvider(config);
  assert.throws(() =>
    createSlackProvider({
      ...config,
      redirectUri: "http://external.example/callback",
    }),
  );
  assert.throws(() =>
    createSlackProvider({
      ...config,
      redirectUri: config.redirectUri + "?next=other",
    }),
  );
  assert.throws(() => createSlackProvider({ ...config, scopes: [] }));
  assert.throws(() =>
    createSlackProvider({
      ...config,
      scopes: ["channels:history", "channels:history"],
    }),
  );
  for (const change of [
    { clientId: "123.789" },
    { appId: "AOTHER" },
    { scopes: ["groups:history" as const] },
  ])
    assert.notEqual(
      createSlackProvider({ ...config, ...change }).binding,
      baseline.binding,
    );
});
