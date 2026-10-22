import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, request } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAccountManager } from "../src/accounts.ts";
import { startAccountConsole } from "../src/account-console.ts";
import { createGmailAdapter } from "../src/gmail.ts";
import {
  createAuthority,
  createClient,
  identity,
  MemoryStore,
} from "../src/index.ts";
import { startProviderFixture } from "../examples/accounts/provider-fixture.ts";

async function setup(t: TestContext, gmail = false) {
  const socket = createServer();
  let temporary: string | undefined;
  let provider!: Awaited<ReturnType<typeof startProviderFixture>>;
  let accounts!: Awaited<ReturnType<typeof openAccountManager>>;
  let app!: Awaited<ReturnType<typeof startAccountConsole>>;
  t.after(async () => {
    await app?.close();
    await accounts?.close();
    await provider?.close();
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  temporary = await mkdtemp(join(tmpdir(), "capvine-console-test-"));
  provider = await startProviderFixture({
    redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
  });
  const accountOptions = {
    directory: join(temporary, "accounts"),
    key: randomBytes(32),
    providers: [provider.provider()],
  };
  const loginKey = randomBytes(32).toString("base64url");
  accounts = await openAccountManager(accountOptions);
  const open = () =>
    startAccountConsole({
      accounts,
      ownerId: "owner",
      loginKey,
      port,
      ...(gmail
        ? { gmail: { source: "fixture" as const, fetch: provider.gmailFetch } }
        : {}),
      providers: [
        {
          id: "google",
          label: "Test provider",
          authorizationOrigin: provider.issuer,
        },
      ],
    });
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  app = await open();
  function browser() {
    let cookie = "";
    let csrf = "";
    async function send(path: string, init: RequestInit = {}) {
      const response = await fetch(app.url + path, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { cookie, ...init.headers },
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      const html = await response.text();
      csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? csrf;
      return { response, html, location: response.headers.get("location") };
    }
    const post = (
      path: string,
      values: Record<string, string> = {},
      headers: Record<string, string> = {},
    ) =>
      send(path, {
        method: "POST",
        headers: {
          origin: app.url,
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams({ csrf, ...values }),
      });
    return {
      send,
      post,
      cookie: () => cookie,
      csrf: () => csrf,
      async login() {
        await send("/login");
        const pre = cookie;
        const result = await post("/login", { key: loginKey });
        assert.equal(result.response.status, 303);
        assert.notEqual(pre, cookie);
        await send("/");
        return pre;
      },
      async connect() {
        await send("/");
        const started = await post("/connections/connect", {
          provider: "google",
        });
        assert.equal(started.response.status, 303);
        const callback = await provider.authorize(started.location!);
        const result = await send(callback.pathname + callback.search);
        assert.equal(result.location, "/?notice=connected");
        return callback;
      },
    };
  }
  return {
    browser,
    loginKey,
    provider,
    url: app.url,
    accounts: () => accounts,
    async restart() {
      await app.close();
      await accounts.close();
      accounts = await openAccountManager(accountOptions);
      app = await open();
    },
  };
}

test("console login, code callback, account listing, disconnect and restart use the real account store", async (t) => {
  const f = await setup(t);
  const b = f.browser();
  assert.equal((await b.send("/")).location, "/login");
  const login = await b.send("/login");
  assert.match(
    login.response.headers.get("set-cookie")!,
    /HttpOnly; SameSite=Lax/,
  );
  assert.equal(login.response.headers.get("cache-control"), "no-store");
  assert.equal(login.response.headers.get("referrer-policy"), "same-origin");
  assert.match(
    login.response.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  await b.login();
  await b.connect();
  const connection = f.accounts().list("owner").connections[0]!;
  const listing = await b.send("/");
  assert.match(listing.html, /fixture-subject/);
  for (const secret of f.provider.secrets())
    assert.equal(listing.html.includes(secret), false);
  await f.restart();
  assert.equal((await b.send("/")).location, "/login");
  await b.login();
  assert.match((await b.send("/")).html, new RegExp(connection.id));
  await b.send(`/connection?id=${connection.id}`);
  assert.equal(
    (await b.post("/connections/disconnect", { id: connection.id })).location,
    "/?notice=disconnected",
  );
  await assert.rejects(
    f.accounts().withAccessToken(
      {
        ownerId: "owner",
        connectionId: connection.id,
        provider: "google",
        subject: "fixture-subject",
      },
      async () => "unexpected",
    ),
  );
  await f.restart();
  assert.equal(
    f.accounts().inspect("owner", connection.id).status,
    "disconnected",
  );
});

test("console rejects cross-origin forms, bad CSRF, duplicate fields, unauthenticated mutations and form replays", async (t) => {
  const f = await setup(t);
  const b = f.browser();
  assert.equal(
    (await b.post("/connections/connect", { provider: "google" })).response
      .status,
    403,
  );
  await b.send("/login");
  assert.equal(
    (
      await b.post(
        "/login",
        { key: f.loginKey },
        { origin: "https://attacker.example" },
      )
    ).response.status,
    403,
  );
  await b.login();
  const csrf = b.csrf();
  for (const headers of [
    { origin: "https://attacker.example" },
    { origin: "null" },
    { origin: "" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    assert.equal(
      (await b.post("/connections/connect", { provider: "google" }, headers))
        .response.status,
      403,
    );
  }
  assert.equal(
    (
      await b.post("/connections/connect", {
        provider: "google",
        csrf: "forged",
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await b.send("/connections/connect", {
        method: "POST",
        headers: {
          origin: f.url,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `csrf=${csrf}&csrf=${csrf}&provider=google`,
      })
    ).response.status,
    400,
  );
  const accepted = await b.post("/connections/connect", { provider: "google" });
  assert.equal(accepted.response.status, 303);
  assert.equal(
    (await b.post("/connections/connect", { provider: "google", csrf }))
      .response.status,
    403,
  );
  assert.equal(f.accounts().list("owner").connections.length, 1);
});

test("OAuth callbacks require the initiating session and are one-use; errors do not echo codes", async (t) => {
  const f = await setup(t);
  const a = f.browser(),
    b = f.browser();
  await a.login();
  await b.login();
  const start = await a.post("/connections/connect", { provider: "google" });
  const callback = await f.provider.authorize(start.location!);
  const route = callback.pathname + callback.search;
  const wrong = await b.send(route);
  assert.equal(wrong.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(wrong.location, "/?notice=callback_failed");
  assert.equal(f.provider.counts.exchanges, 0);
  assert.equal((await a.send(route)).location, "/?notice=connected");
  assert.equal((await a.send(route)).location, "/?notice=callback_failed");
  assert.equal(f.provider.counts.exchanges, 1);
  assert.equal(wrong.html.includes(callback.searchParams.get("code")!), false);
  assert.equal((await f.browser().send(route)).location, "/login");
});

test("an account connected in the console supports a delegated read until the owner disconnects it", async (t) => {
  const f = await setup(t);
  const b = f.browser();
  await b.login();
  await b.connect();
  const account = f.accounts().list("owner").connections[0]!;
  const adapter = createGmailAdapter({
    accounts: f.accounts(),
    ownerId: "owner",
    fetch: f.provider.gmailFetch,
    messages: [
      {
        id: "urn:capvine:resource:mail",
        connectionId: account.id,
        subject: account.subject!,
        messageId: "a42",
      },
    ],
  });
  const store = new MemoryStore();
  store.addResource(adapter.resources[0]!);
  store.addTask({ id: "job", ownerId: "owner", active: true });
  const signer = await identity.generate(),
    worker = await identity.generate();
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
  assert.equal(f.provider.counts.refreshes, 1);
  await b.send(`/connection?id=${account.id}`);
  await b.post("/connections/disconnect", { id: account.id });
  await assert.rejects(client.invoke(grant));
  assert.equal(f.provider.counts.reads, 1);
});

test("logout, expiration and session rotation invalidate access and pending callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date() });
  const f = await setup(t);
  const b = f.browser();
  const pre = await b.login();
  assert.equal(
    (await b.send("/", { headers: { cookie: pre } })).location,
    "/login",
  );
  const start = await b.post("/connections/connect", { provider: "google" });
  const callback = await f.provider.authorize(start.location!);
  await b.send("/");
  const old = b.cookie();
  await b.post("/logout");
  assert.equal(
    (await b.send("/", { headers: { cookie: old } })).location,
    "/login",
  );
  await b.login();
  assert.equal(
    (await b.send(callback.pathname + callback.search)).location,
    "/?notice=callback_failed",
  );
  t.mock.timers.tick(1_800_001);
  assert.equal((await b.send("/")).location, "/login");
  assert.equal(
    (await b.post("/connections/connect", { provider: "google" })).response
      .status,
    403,
  );
  assert.equal(f.provider.counts.exchanges, 0);
});

test("reconnect creates a fresh ID and leaves old resource bindings disconnected", async (t) => {
  const f = await setup(t);
  const b = f.browser();
  await b.login();
  await b.connect();
  const old = f.accounts().list("owner").connections[0]!;
  await b.send(`/connection?id=${old.id}`);
  const start = await b.post("/connections/reconnect", { id: old.id });
  assert.equal(f.accounts().inspect("owner", old.id).status, "disconnected");
  const callback = await f.provider.authorize(start.location!);
  assert.equal(
    (await b.send(callback.pathname + callback.search)).location,
    "/?notice=connected",
  );
  const current = f
    .accounts()
    .list("owner")
    .connections.find((c) => c.status === "connected")!;
  assert.notEqual(current.id, old.id);
  await assert.rejects(
    f.accounts().withAccessToken(
      {
        ownerId: "owner",
        connectionId: old.id,
        provider: "google",
        subject: old.subject!,
      },
      async () => "unexpected",
    ),
  );
});

test("console and account listings never authorize another owner's connection", async (t) => {
  const f = await setup(t);
  await f.accounts().begin({
    ownerId: "other",
    sessionId: randomBytes(32).toString("hex"),
    connectionId: "other-account",
    provider: "google",
  });
  const b = f.browser();
  await b.login();
  assert.equal((await b.send("/")).html.includes("other-account"), false);
  for (const action of ["disconnect", "reconnect"]) {
    await b.send("/");
    assert.equal(
      (await b.post(`/connections/${action}`, { id: "other-account" })).response
        .status,
      400,
    );
  }
  assert.equal(
    (await b.send("/connection?id=other-account")).response.status,
    400,
  );
  assert.equal(
    f.accounts().inspect("other", "other-account").status,
    "connecting",
  );
  assert.deepEqual(f.accounts().list("owner").connections, []);
  assert.equal(
    JSON.stringify(f.accounts().list("owner", { limit: 1 })).includes(
      "other-account",
    ),
    false,
  );
});

test("listing is bounded, paginated, survives restart and exposes only metadata", async (t) => {
  const f = await setup(t);
  for (const connectionId of ["a", "b", "c"])
    await f.accounts().begin({
      ownerId: "owner",
      sessionId: randomBytes(32).toString("hex"),
      connectionId,
      provider: "google",
    });
  const first = f.accounts().list("owner", { limit: 2 });
  assert.deepEqual(
    first.connections.map((c) => c.id),
    ["a", "b"],
  );
  assert.match(first.nextCursor!, /^[0-9]+$/);
  await f.restart();
  assert.deepEqual(
    f
      .accounts()
      .list("owner", { after: first.nextCursor!, limit: 2 })
      .connections.map((c) => c.id),
    ["c"],
  );
  assert.equal("tokens" in first.connections[0]!, false);
  assert.throws(() => f.accounts().list("owner", { limit: 101 }));
  assert.throws(() => f.accounts().list("owner", { after: "' OR 1=1" }));
});

test("console rejects hostile Host headers, absolute request URLs and oversized forms", async (t) => {
  const f = await setup(t);
  const raw = (path: string, host: string) =>
    new Promise<number>((resolve) => {
      const req = request(f.url, { path, headers: { host } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      req.end();
    });
  assert.equal(await raw("/login", "attacker.example"), 403);
  assert.equal(
    await raw("https://attacker.example/login", new URL(f.url).host),
    400,
  );
  const b = f.browser();
  await b.login();
  assert.equal(
    (
      await b.post("/connections/connect", {
        provider: "google",
        padding: "x".repeat(70_000),
      })
    ).response.status,
    413,
  );
  assert.equal(f.accounts().list("owner").connections.length, 0);
});

test("failed login attempts are limited without exposing the configured key", async (t) => {
  const f = await setup(t);
  const b = f.browser();
  await b.send("/login");
  for (let i = 0; i < 10; i++) {
    const failed = await b.post("/login", { key: "wrong" });
    assert.equal(failed.response.status, 401);
    assert.equal(failed.html.includes(f.loginKey), false);
  }
  assert.equal(
    (await b.post("/login", { key: f.loginKey })).response.status,
    429,
  );
});

function hiddenField(html: string, name: string) {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  assert.ok(match, `Missing ${name} field`);
  return match;
}

async function gmailSetup(t: TestContext) {
  const f = await setup(t, true);
  const b = f.browser();
  await b.login();
  await b.connect();
  const connection = f.accounts().list("owner").connections[0]!;
  let html = (await b.send(`/gmail?connection=${connection.id}`)).html;
  async function post(path: string, values: Record<string, string> = {}) {
    const response = await b.post(path, values);
    assert.equal(response.response.status, 303);
    assert.equal(response.location, "/gmail");
    html = (await b.send("/gmail")).html;
    return html;
  }
  const load = () => post("/gmail/load", { connection: connection.id });
  const select = (message = "a42") =>
    post("/gmail/select", {
      selection: hiddenField(html, "selection"),
      message,
    });
  const action = (action: string) =>
    post("/gmail/action", { run: hiddenField(html, "run"), action });
  return { ...f, b, connection, post, load, select, action, html: () => html };
}

test("authenticated Gmail console lists IDs, delegates a read, rejects signed attacks, and revokes access", async (t) => {
  const f = await gmailSetup(t);
  assert.equal(f.provider.counts.lists, 0);
  await f.load();
  assert.equal(f.provider.counts.lists, 1);
  assert.equal(f.provider.counts.reads, 0);
  assert.doesNotMatch(f.html(), /Quarterly report/);
  await f.select();
  assert.match(f.html(), /Awaiting your approval/);
  await f.action("approve");
  await f.action("delegate");
  assert.equal(f.provider.counts.reads, 0);
  const result = await f.action("read");
  assert.match(result, /Quarterly report/);
  assert.match(result, /The report is ready/);
  assert.match(result, /read: ALLOWED/);
  assert.equal(f.provider.counts.reads, 1);
  for (const secret of f.provider.secrets())
    assert.equal(result.includes(secret), false);
  for (const action of ["other-resource", "write", "other-worker", "expired"]) {
    const denied = await f.action(action);
    assert.match(denied, new RegExp(`${action}: DENIED`));
    assert.doesNotMatch(denied, /boundary check failed/);
    assert.match(denied, /Quarterly report/);
    assert.equal(f.provider.counts.reads, 1);
  }
  await f.action("read");
  assert.equal(f.provider.counts.reads, 2);
  assert.doesNotMatch(await f.action("revoke"), /Quarterly report/);
  const revoked = await f.action("read");
  assert.match(revoked, /read: DENIED/);
  assert.equal(f.provider.counts.reads, 2);
  await f.post("/gmail/reset");
  await f.select("b43");
  await f.action("approve");
  await f.action("delegate");
  assert.match(await f.action("read"), /Quarterly report/);
  assert.doesNotMatch(await f.action("end-task"), /Quarterly report/);
  assert.match(await f.action("read"), /read: DENIED/);
  assert.equal(f.provider.counts.reads, 3);
});

test("provider revocation appears in the console and reconnect requires a new Gmail selection", async (t) => {
  const f = await gmailSetup(t);
  await f.load();
  await f.select();
  await f.action("approve");
  await f.action("delegate");
  await f.action("read");
  const oldRun = hiddenField(f.html(), "run");
  f.provider.revoke();
  await f.b.post("/gmail/action", { run: oldRun, action: "read" });
  assert.equal(f.provider.counts.reads, 1);
  assert.match((await f.b.send("/")).html, /Reconnect required/);
  await f.restart();
  await f.b.login();
  assert.match((await f.b.send("/")).html, /Reconnect required/);
  await f.b.send(`/connection?id=${f.connection.id}`);
  const start = await f.b.post("/connections/reconnect", {
    id: f.connection.id,
  });
  assert.equal(start.response.status, 303);
  const callback = await f.provider.authorize(start.location!);
  assert.equal(
    (await f.b.send(callback.pathname + callback.search)).location,
    "/?notice=connected",
  );
  const current = f
    .accounts()
    .list("owner")
    .connections.find((c) => c.status === "connected")!;
  assert.notEqual(current.id, f.connection.id);
  await f.b.send("/gmail");
  assert.equal(
    (await f.b.post("/gmail/action", { run: oldRun, action: "read" })).location,
    "/gmail?error=action",
  );
  assert.equal(f.provider.counts.reads, 1);
  await f.b.send("/gmail");
  await f.post("/gmail/load", { connection: current.id });
  await f.select();
  assert.match(f.html(), /Awaiting your approval/);
  await f.action("approve");
  await f.action("delegate");
  assert.match(await f.action("read"), /Quarterly report/);
  assert.equal(f.provider.counts.reads, 2);
});

test("Gmail console binds selections and runs to the authenticated session and rejects tampered controls", async (t) => {
  const f = await gmailSetup(t);
  const guest = f.browser();
  assert.equal((await guest.send("/gmail")).location, "/login");
  assert.equal(
    (await guest.post("/gmail/load", { connection: f.connection.id })).response
      .status,
    403,
  );
  assert.equal(
    (
      await f.b.post(
        "/gmail/load",
        { connection: f.connection.id },
        { origin: "https://attacker.example" },
      )
    ).response.status,
    403,
  );
  assert.equal(f.provider.counts.lists, 0);
  await f.load();
  const selection = hiddenField(f.html(), "selection");
  assert.equal(
    (await f.b.post("/gmail/select", { selection, message: "deadbeef" }))
      .location,
    "/gmail?error=action",
  );
  await f.b.send("/gmail");
  assert.equal(
    (
      await f.b.post("/gmail/select", {
        selection,
        message: "a42",
        resource: "other",
      })
    ).response.status,
    400,
  );
  await f.b.send("/gmail");
  await f.select();
  const run = hiddenField(f.html(), "run");
  await f.action("approve");
  await f.action("delegate");
  const other = f.browser();
  await other.login();
  assert.equal(
    (await other.post("/gmail/action", { run, action: "read" })).location,
    "/gmail?error=action",
  );
  const another = await other.send("/gmail");
  assert.doesNotMatch(another.html, /Quarterly report/);
  assert.equal(f.provider.counts.reads, 0);
  await f.b.post("/logout");
  await f.b.login();
  assert.equal(
    (await f.b.post("/gmail/action", { run, action: "read" })).location,
    "/gmail?error=action",
  );
  assert.equal(f.provider.counts.reads, 0);
});

test("Gmail console escapes provider text and drops old results on reset, disconnect, and restart", async (t) => {
  const f = await gmailSetup(t);
  f.provider.controls.messageSubject = '<img src=x onerror="alert(1)">';
  await f.load();
  await f.select();
  await f.action("approve");
  await f.action("delegate");
  const read = await f.action("read");
  assert.doesNotMatch(read, /<img src=x/);
  assert.match(read, /&lt;img src=x/);
  const oldRun = hiddenField(read, "run");
  assert.doesNotMatch(await f.post("/gmail/reset"), /&lt;img src=x/);
  assert.equal(
    (await f.b.post("/gmail/action", { run: oldRun, action: "read" })).location,
    "/gmail?error=action",
  );
  await f.b.send("/gmail");
  await f.select();
  await f.action("approve");
  await f.action("delegate");
  const run = hiddenField(f.html(), "run");
  await f.b.post("/connections/disconnect", { id: f.connection.id });
  const disconnected = await f.b.send("/gmail");
  assert.doesNotMatch(disconnected.html, /&lt;img src=x/);
  assert.equal(
    (await f.b.post("/gmail/action", { run, action: "read" })).location,
    "/gmail?error=action",
  );
  assert.equal(f.provider.counts.reads, 1);
  await f.restart();
  assert.equal((await f.b.send("/gmail")).location, "/login");
});

test("a Gmail selection finishing after sign-out cannot restore a session or grant access", async (t) => {
  const f = await gmailSetup(t);
  let arrived!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.provider.controls.beforeList = async () => {
    arrived();
    await gate;
  };
  const loading = f.b.post("/gmail/load", { connection: f.connection.id });
  await entered;
  await f.b.send("/gmail");
  await f.b.post("/logout");
  release();
  await loading;
  assert.equal((await f.b.send("/gmail")).location, "/login");
  await f.b.login();
  assert.doesNotMatch((await f.b.send("/gmail")).html, /name="selection"/);
  assert.equal(f.provider.counts.reads, 0);
});
