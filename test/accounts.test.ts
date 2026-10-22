import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { invoke } from "@ucanto/client";
import { openAccountManager } from "../src/accounts.ts";
import { createGmailAdapter } from "../src/gmail.ts";
import { createOidcProvider } from "../src/oauth.ts";
import {
  createAuthority,
  createClient,
  encodeGrant,
  identity,
  MemoryStore,
  PermissionDenied,
} from "../src/index.ts";
import { startProviderFixture } from "../examples/accounts/provider-fixture.ts";

async function setup(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), "capvine-accounts-test-"));
  const directory = join(temporary, "credentials");
  const key = randomBytes(32);
  const provider = await startProviderFixture();
  const options = { directory, key, providers: [provider.provider()] };
  let manager = await openAccountManager(options);
  t.after(async () => {
    await manager.close();
    await provider.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const sessionId = randomBytes(32).toString("base64url");
  const begin = (connectionId = "mail") =>
    manager.begin({
      ownerId: "owner",
      sessionId,
      connectionId,
      provider: "google",
    });
  const complete = (callback: URL) =>
    manager.complete({ ownerId: "owner", sessionId, callback });
  const use = (
    call: (token: string) => Promise<unknown> = async () => "allowed",
  ) =>
    manager.withAccessToken(
      {
        ownerId: "owner",
        connectionId: "mail",
        provider: "google",
        subject: "fixture-subject",
      },
      call,
    );
  return {
    directory,
    options,
    provider,
    sessionId,
    begin,
    complete,
    use,
    manager: () => manager,
    connect: async () =>
      complete(await provider.authorize((await begin()).url)),
    restart: async () => {
      await manager.close();
      manager = await openAccountManager(options);
    },
  };
}

test("direct OAuth credentials are encrypted; serialized refresh rotation survives restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date() });
  const f = await setup(t);
  const connected = await f.connect();
  assert.equal(connected.subject, "fixture-subject");
  assert.equal(connected.status, "connected");
  assert.equal("tokens" in connected, false);
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
  const database = await readFile(join(f.directory, "accounts.db"));
  for (const secret of f.provider.secrets())
    assert.equal(database.includes(Buffer.from(secret)), false);
  assert.equal(
    JSON.stringify(f.manager().inspect("owner", "mail")).includes(
      "accessToken",
    ),
    false,
  );
});

test("state is bound to the owner and session, expiring, and single use across restart", async (t) => {
  const f = await setup(t);
  const started = await f.begin();
  const callback = await f.provider.authorize(started.url);
  await f.restart();
  await assert.rejects(
    f
      .manager()
      .complete({ ownerId: "other", sessionId: f.sessionId, callback }),
  );
  await assert.rejects(
    f.manager().complete({ ownerId: "owner", sessionId: "wrong", callback }),
  );
  const changed = new URL(callback);
  changed.searchParams.set("state", randomBytes(32).toString("base64url"));
  await assert.rejects(f.complete(changed));
  const duplicated = new URL(callback);
  duplicated.searchParams.append("state", callback.searchParams.get("state")!);
  await assert.rejects(f.complete(duplicated));
  const results = await Promise.allSettled([
    f.complete(callback),
    f.complete(callback),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(f.provider.counts.exchanges, 1);
  await assert.rejects(f.complete(callback));
  assert.throws(() => f.manager().inspect("other", "mail"));
  assert.throws(() => f.manager().disconnect("other", "mail"));
});

test("expired connection flows cannot exchange a code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date() });
  const f = await setup(t);
  const callback = await f.provider.authorize((await f.begin()).url);
  t.mock.timers.tick(600_001);
  await assert.rejects(f.complete(callback), /expired/);
  assert.equal(f.provider.counts.exchanges, 0);
});

for (const failure of [
  "badNonce",
  "badAudience",
  "badIssuer",
  "badSignature",
  "omitRefresh",
  "reducedScope",
  "wrongSubject",
  "oversized",
  "redirectToken",
] as const) {
  test(`connection rejects ${failure} without enabling account access`, async (t) => {
    const f = await setup(t);
    f.provider.controls[failure] = true;
    const callback = await f.provider.authorize((await f.begin()).url);
    await assert.rejects(f.complete(callback), {
      message: "Account connection failed; start a new connection",
    });
    await assert.rejects(f.use());
    assert.equal(f.manager().inspect("owner", "mail").status, "connecting");
    assert.equal(f.provider.counts.reads, 0);
  });
}

test("callback origin and code substitution cannot bypass PKCE", async (t) => {
  const f = await setup(t);
  const a = await f.provider.authorize((await f.begin()).url);
  const b = await f.provider.authorize((await f.begin("mail-b")).url);
  const swapped = new URL(a);
  swapped.searchParams.set("code", b.searchParams.get("code")!);
  await assert.rejects(f.complete(swapped));
  assert.equal(f.provider.counts.exchanges, 0);
  const wrongDestination = new URL(b);
  wrongDestination.pathname = "/other";
  await assert.rejects(f.complete(wrongDestination));
  assert.equal(f.provider.counts.exchanges, 0);
});

test("invalid refresh grants persist reconnect-required state without repeated provider requests", async (t) => {
  const f = await setup(t);
  await f.connect();
  f.provider.controls.invalidGrant = true;
  await assert.rejects(f.use(), { message: "Account refresh failed" });
  assert.equal(
    f.manager().inspect("owner", "mail").status,
    "reconnect_required",
  );
  await f.restart();
  await assert.rejects(f.use());
  assert.equal(f.provider.counts.refreshes, 1);
});

for (const authenticationChallenge of [true, false]) {
  test(`revoked unexpired tokens require a fresh connection (challenge: ${authenticationChallenge})`, async (t) => {
    const f = await setup(t);
    f.provider.controls.shortAccess = false;
    f.provider.controls.authenticationChallenge = authenticationChallenge;
    await f.connect();
    f.provider.revoke();
    let dispatched = 0;
    const use = () => f.use(async () => dispatched++);
    const profiles = f.provider.counts.profiles;
    await Promise.all([assert.rejects(use()), assert.rejects(use())]);
    assert.equal(dispatched, 0);
    assert.equal(
      f.manager().inspect("owner", "mail").status,
      "reconnect_required",
    );
    assert.equal(f.provider.counts.profiles, profiles + 1);
    assert.equal(f.provider.counts.refreshes, 0);
    await f.restart();
    await assert.rejects(use());
    await assert.rejects(f.begin());
    assert.equal(f.provider.counts.profiles, profiles + 1);
    const connected = await f.complete(
      await f.provider.authorize((await f.begin("mail-new")).url),
    );
    assert.equal(connected.status, "connected");
    assert.equal(
      await f.manager().withAccessToken(
        {
          ownerId: "owner",
          connectionId: "mail-new",
          provider: "google",
          subject: "fixture-subject",
        },
        async () => "allowed",
      ),
      "allowed",
    );
    await assert.rejects(use());
    assert.equal(dispatched, 0);
  });
}

for (const status of [403, 429, 503]) {
  test(`UserInfo HTTP ${status} blocks dispatch without discarding credentials`, async (t) => {
    const f = await setup(t);
    f.provider.controls.shortAccess = false;
    await f.connect();
    f.provider.controls.profileStatus = status;
    let dispatched = false;
    await assert.rejects(
      f.use(async () => {
        dispatched = true;
      }),
    );
    assert.equal(dispatched, false);
    assert.equal(f.manager().inspect("owner", "mail").status, "connected");
    await f.restart();
    f.provider.controls.profileStatus = 200;
    assert.equal(await f.use(), "allowed");
    assert.equal(f.provider.counts.refreshes, 0);
  });
}

test("failed revocation-state persistence never permits credential dispatch", async (t) => {
  const f = await setup(t);
  f.provider.controls.shortAccess = false;
  await f.connect();
  f.provider.revoke();
  const database = new DatabaseSync(join(f.directory, "accounts.db"));
  t.after(() => database.close());
  database.exec(
    "CREATE TRIGGER reject_update BEFORE UPDATE ON account_records BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
  );
  let dispatched = false;
  const use = () =>
    f.use(async () => {
      dispatched = true;
    });
  await assert.rejects(use());
  assert.equal(dispatched, false);
  assert.equal(f.manager().inspect("owner", "mail").status, "connected");
  database.exec("DROP TRIGGER reject_update");
  await assert.rejects(use());
  assert.equal(dispatched, false);
  assert.equal(
    f.manager().inspect("owner", "mail").status,
    "reconnect_required",
  );
});

test("refresh preserves an omitted replacement token and rejects identity or scope loss", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date() });
  const f = await setup(t);
  await f.connect();
  f.provider.controls.omitRefresh = true;
  assert.equal(await f.use(), "allowed");
  await f.restart();
  t.mock.timers.tick(3_600_001);
  f.provider.controls.wrongSubject = true;
  await assert.rejects(f.use());
  f.provider.controls.wrongSubject = false;
  f.provider.controls.reducedScope = true;
  await assert.rejects(f.use());
  assert.equal(
    f.manager().inspect("owner", "mail").status,
    "reconnect_required",
  );
});

for (const phase of [
  "refresh",
  "connection",
  "profile",
  "revoked-profile",
] as const) {
  test(`disconnect during ${phase} prevents credential resurrection and dispatch`, async (t) => {
    const f = await setup(t);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = async () => {
      started();
      await blocked;
    };
    let dispatched = false;
    let result: Promise<void>;
    if (phase === "connection") {
      f.provider.controls.beforeProfile = hold;
      const callback = await f.provider.authorize((await f.begin()).url);
      result = assert.rejects(f.complete(callback));
    } else {
      f.provider.controls.shortAccess = phase === "refresh";
      await f.connect();
      if (phase === "refresh") f.provider.controls.beforeRefresh = hold;
      else f.provider.controls.beforeProfile = hold;
      result = assert.rejects(
        f.use(async () => {
          dispatched = true;
        }),
      );
    }
    try {
      await reached;
      if (phase === "revoked-profile") f.provider.revoke();
      f.manager().disconnect("owner", "mail");
    } finally {
      release();
    }
    await result;
    await f.restart();
    assert.equal(f.manager().inspect("owner", "mail").status, "disconnected");
    assert.equal(dispatched, false);
    await assert.rejects(f.begin());
    await assert.rejects(f.use());
  });
}

test("credential persistence failure blocks dispatch after token rotation", async (t) => {
  const f = await setup(t);
  await f.connect();
  const database = new DatabaseSync(join(f.directory, "accounts.db"));
  t.after(() => database.close());
  database.exec(
    "CREATE TRIGGER reject_update BEFORE UPDATE ON account_records BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
  );
  let dispatched = false;
  await assert.rejects(
    f.use(async () => {
      dispatched = true;
    }),
    /refresh failed/,
  );
  assert.equal(dispatched, false);
  database.exec("DROP TRIGGER reject_update");
  await assert.rejects(f.use());
  assert.equal(
    f.manager().inspect("owner", "mail").status,
    "reconnect_required",
  );
});

test("exclusive state ownership, wrong keys, and tampered ciphertext fail closed", async (t) => {
  const f = await setup(t);
  await f.connect();
  await assert.rejects(openAccountManager(f.options), /EEXIST/);
  await f.manager().close();
  await assert.rejects(
    openAccountManager({ ...f.options, key: randomBytes(32) }),
    /could not be opened/,
  );
  await f.restart();
  await f.manager().close();
  const database = new DatabaseSync(join(f.directory, "accounts.db"));
  database
    .prepare("UPDATE account_records SET value=? WHERE kind='connection'")
    .run(Buffer.alloc(64));
  database.close();
  await f.restart();
  await assert.rejects(f.use());
});

test("direct Gmail reads require valid Capvine grants and preserve account/resource binding", async (t) => {
  const f = await setup(t);
  await f.connect();
  const adapter = createGmailAdapter({
    accounts: f.manager(),
    ownerId: "owner",
    fetch: f.provider.gmailFetch,
    messages: [
      {
        id: "urn:capvine:resource:mail",
        connectionId: "mail",
        subject: "fixture-subject",
        messageId: "a42",
      },
    ],
  });
  const store = new MemoryStore();
  store.addResource(adapter.resources[0]!);
  store.addTask({ id: "job", ownerId: "owner", active: true });
  const signer = await identity.generate();
  const worker = await identity.generate();
  const authority = createAuthority({
    signer,
    store,
    authorizeGrant: ({ actor }) => actor === "owner",
  });
  authority.registerOperation(adapter.operations[0]!);
  const grant = await authority.issue({
    actor: "owner",
    audience: worker,
    resource: adapter.resources[0]!.id,
    action: "gmail/message.read",
    taskId: "job",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const client = createClient({
    signer: worker,
    service: signer,
    transport: authority.execute,
  });
  assert.deepEqual(await client.invoke(grant), {
    id: "a42",
    subject: "Quarterly report",
    snippet: "The report is ready.",
  });
  const forged = await invoke({
    issuer: worker,
    audience: signer,
    proofs: [grant],
    capability: {
      ...grant.capabilities[0]!,
      with: "urn:capvine:resource:other",
    },
    expiration: grant.expiration,
  }).delegate();
  await assert.rejects(
    authority.execute(await encodeGrant(forged)),
    PermissionDenied,
  );
  await assert.rejects(
    adapter.operations[0]!.execute({
      ...adapter.resources[0]!,
      target: { ...adapter.resources[0]!.target, messageId: "b43" },
    }),
    PermissionDenied,
  );
  f.provider.controls.wrongSubject = true;
  await assert.rejects(client.invoke(grant), /Gmail read failed/);
  f.provider.controls.wrongSubject = false;
  f.provider.revoke();
  await assert.rejects(client.invoke(grant), /Gmail read failed/);
  assert.equal(
    f.manager().inspect("owner", "mail").status,
    "reconnect_required",
  );
  await f.complete(await f.provider.authorize((await f.begin("mail-new")).url));
  const profiles = f.provider.counts.profiles;
  await assert.rejects(client.invoke(grant), /Gmail read failed/);
  assert.equal(f.provider.counts.profiles, profiles);
  store.endTask("job");
  await assert.rejects(client.invoke(grant), PermissionDenied);
  assert.equal(f.provider.counts.reads, 1);
});

test("provider setup refuses insecure endpoints and authorization parameter overrides", () => {
  const options = {
    id: "provider",
    issuer: "https://example.com",
    authorizationEndpoint: "https://example.com/auth",
    tokenEndpoint: "https://example.com/token",
    userInfoEndpoint: "https://example.com/profile",
    jwksUri: "https://example.com/keys",
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1:8888/callback",
    scopes: ["openid"],
  };
  assert.throws(() =>
    createOidcProvider({
      ...options,
      tokenEndpoint: "http://example.com/token",
    }),
  );
  assert.throws(() =>
    createOidcProvider({
      ...options,
      authorizationParams: { redirect_uri: "https://other.example" },
    }),
  );
  assert.throws(() =>
    createOidcProvider({
      ...options,
      redirectUri: "https://user:password@example.com/callback",
    }),
  );
});

test("changed provider bindings and caller identities cannot use saved credentials", async (t) => {
  const f = await setup(t);
  await f.connect();
  const input = {
    ownerId: "owner",
    connectionId: "mail",
    provider: "google",
    subject: "fixture-subject",
  };
  for (const change of [
    { ownerId: "other" },
    { provider: "other" },
    { subject: "other" },
  ])
    await assert.rejects(
      f
        .manager()
        .withAccessToken({ ...input, ...change }, async () => "unreachable"),
    );
  await f.manager().close();
  const changed = await openAccountManager({
    ...f.options,
    providers: [
      { ...f.provider.provider(), binding: "changed-client-or-endpoint" },
    ],
  });
  try {
    await assert.rejects(
      changed.withAccessToken(input, async () => "unreachable"),
      /configuration changed/,
    );
    assert.equal(f.provider.counts.refreshes, 0);
  } finally {
    await changed.close();
  }
});

test("Gmail rejects wrong message IDs, oversized responses, and redirects", async (t) => {
  const f = await setup(t);
  await f.connect();
  const adapter = createGmailAdapter({
    accounts: f.manager(),
    ownerId: "owner",
    fetch: f.provider.gmailFetch,
    messages: [
      {
        id: "urn:capvine:resource:mail",
        connectionId: "mail",
        subject: "fixture-subject",
        messageId: "a42",
      },
    ],
  });
  for (const failure of [
    "wrongMessage",
    "oversizedMessage",
    "redirectMessage",
  ] as const) {
    f.provider.controls[failure] = true;
    await assert.rejects(
      adapter.operations[0]!.execute(adapter.resources[0]!),
      { message: "Gmail read failed" },
    );
    f.provider.controls[failure] = false;
  }
});
