import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { invoke } from "@ucanto/client";
import {
  createClient,
  identity,
  encodeGrant,
  PermissionDenied,
  type Resource,
} from "../src/index.ts";
import { createHttpTransport } from "../src/http.ts";
import { createAdministrationClient } from "../src/administration.ts";
import { initializeService, startService } from "../src/service.ts";
import { loadIdentity } from "../src/identity-file.ts";
import { SqliteStore } from "../src/sqlite.ts";

const resource: Resource = {
  id: "urn:capvine:resource:record",
  ownerId: "owner",
  kind: "record",
  target: { id: "fixed" },
};

async function setup(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "capvine-service-"));
  const directory = join(parent, "state");
  await initializeService(directory, "owner");
  const token = (await readFile(join(directory, "admin.token"), "utf8")).trim();
  let calls = 0;
  const options = {
    directory,
    owner: "owner",
    resources: [resource],
    operations: [
      {
        action: "record/read",
        resourceKind: "record",
        execute: async (r: Readonly<Resource>) => {
          calls++;
          return r.target.id!;
        },
      },
    ],
  };
  let service = await startService(options);
  t.after(async () => {
    await service.close();
    await rm(parent, { recursive: true, force: true });
  });
  const admin = () =>
    createAdministrationClient({ url: service.administrationUrl, token });
  const worker = await identity.generate();
  const client = () =>
    createClient({
      signer: worker,
      service: service.principal,
      transport: createHttpTransport({ url: service.url }),
    });
  const issue = () =>
    admin().issue({
      audience: worker,
      taskId: "job",
      resource: resource.id,
      action: "record/read",
      expiresAt: new Date(Date.now() + 300_000),
    });
  return {
    directory,
    token,
    options,
    worker,
    admin,
    client,
    issue,
    calls: () => calls,
    service: () => service,
    restart: async (resources = [resource]) => {
      await service.close();
      service = await startService({ ...options, resources });
    },
  };
}

test("authenticated administration and child revocation survive an authority restart", async (t) => {
  const f = await setup(t);
  const did = f.service().principal.did();
  await f.admin().createTask("job");
  const parent = await f.issue();
  const childIdentity = await identity.generate();
  const child = await f.client().delegate({
    grant: parent,
    audience: childIdentity,
    expiresAt: new Date(Date.now() + 120_000),
  });
  const childClient = () =>
    createClient({
      signer: childIdentity,
      service: f.service().principal,
      transport: createHttpTransport({ url: f.service().url }),
    });
  assert.equal(await childClient().invoke(child), "fixed");
  await f.restart();
  assert.equal(f.service().principal.did(), did);
  assert.equal(await childClient().invoke(child), "fixed");
  await f.admin().revoke(parent.cid.toString());
  const independent = await f.issue();
  await f.restart();
  await assert.rejects(childClient().invoke(child), PermissionDenied);
  assert.equal(await f.client().invoke(independent), "fixed");
  await f.admin().endTask("job");
  await f.restart();
  await assert.rejects(f.client().invoke(independent), PermissionDenied);
  await assert.rejects(f.issue(), /403/);
  assert.equal(f.calls(), 3);
  const audit = await f.admin().audit();
  assert.ok(Array.isArray(audit) && audit.length >= 5);
  assert.ok(!JSON.stringify(audit).includes(f.token));
});

test("saved workflow approvals renew across restart and disable every dependent grant", async (t) => {
  const f = await setup(t);
  const approved = {
    id: "daily-read",
    audience: f.worker,
    resource: resource.id,
    action: "record/read",
    expiresAt: new Date(Date.now() + 86_400_000),
    maxGrantSeconds: 600,
  };
  await f.admin().approveWorkflow(approved);
  const first = await f.admin().issueApproved(approved.id);
  assert.equal(await f.client().invoke(first), "fixed");
  await f.restart();
  const next = await f.admin().issueApproved(approved.id);
  assert.equal(await f.client().invoke(next), "fixed");
  assert.equal(await f.client().invoke(first), "fixed");
  assert.notEqual(first.cid.toString(), next.cid.toString());
  const childSigner = await identity.generate();
  const child = await f.client().delegate({
    grant: next,
    audience: childSigner,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await f.admin().disableApproval(approved.id);
  await f.restart();
  await assert.rejects(f.admin().issueApproved(approved.id), /403/);
  for (const grant of [first, next])
    await assert.rejects(f.client().invoke(grant), PermissionDenied);
  const request = await invoke({
    issuer: childSigner,
    audience: f.service().principal,
    capability: child.capabilities[0]!,
    proofs: [child],
    expiration: child.expiration,
  }).delegate();
  await assert.rejects(
    createHttpTransport({ url: f.service().url })(await encodeGrant(request)),
    PermissionDenied,
  );
  const approval = await f.admin().readApproval(approved.id);
  assert.ok(approval && typeof approval === "object" && "active" in approval);
  assert.equal(approval.active, false);
  await assert.rejects(f.admin().approveWorkflow(approved), /500/);
  assert.equal(f.calls(), 3);
});

test("approval commands require operator authentication and cannot override saved bindings", async (t) => {
  const f = await setup(t);
  await f.admin().approveWorkflow({
    id: "fixed",
    audience: f.worker,
    resource: resource.id,
    action: "record/read",
    expiresAt: new Date(Date.now() + 60_000),
    maxGrantSeconds: 60,
  });
  async function command(
    params: unknown,
    token = f.token,
    url = f.service().administrationUrl,
    method = "approval.issue",
  ) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method, params }),
    });
    await response.body?.cancel();
    return response.status;
  }
  assert.equal(await command({ id: "fixed" }, "wrong"), 401);
  assert.equal(
    await command(
      { id: "fixed" },
      f.token,
      new URL("/admin", f.service().url).href,
    ),
    404,
  );
  for (const field of [
    "audience",
    "resource",
    "action",
    "expiresAt",
    "ownerId",
    "taskId",
  ])
    assert.equal(await command({ id: "fixed", [field]: "replacement" }), 400);
  assert.equal(await command({ id: "unknown" }), 403);
  assert.equal(
    await command(
      { after: "", limit: 20 },
      "wrong",
      f.service().administrationUrl,
      "approval.list",
    ),
    401,
  );
  assert.equal(
    await command(
      { after: "", limit: 20, ownerId: "other" },
      f.token,
      f.service().administrationUrl,
      "approval.list",
    ),
    400,
  );
  assert.equal(
    await command(
      { after: "", limit: 20 },
      f.token,
      new URL("/admin", f.service().url).href,
      "approval.list",
    ),
    404,
  );
  await f.restart([]);
  await assert.rejects(f.admin().issueApproved("fixed"), /403/);
  assert.equal(f.calls(), 0);
});

test("request fields cannot impersonate the owner or access administration on the invocation port", async (t) => {
  const f = await setup(t);
  async function command(body: unknown, token = f.token, origin?: string) {
    const response = await fetch(f.service().administrationUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    });
    await response.body?.cancel();
    return response.status;
  }
  assert.equal(
    await command({ method: "task.create", params: { id: "job" } }, "wrong"),
    401,
  );
  assert.equal(
    await command({
      method: "task.create",
      params: { id: "job", ownerId: "other" },
    }),
    400,
  );
  assert.equal(
    await command(
      { method: "task.create", params: { id: "job" } },
      f.token,
      "https://example.com",
    ),
    400,
  );
  assert.equal(
    await command({ method: "task.create", params: { id: "job" } }),
    200,
  );
  assert.equal(
    await command({ method: "task.create", params: { id: "job" } }),
    409,
  );
  assert.equal(
    await command({
      method: "grant.issue",
      params: {
        audience: f.worker.did(),
        taskId: "job",
        resource: resource.id,
        action: "record/read",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        actor: "owner",
      },
    }),
    400,
  );
  const response = await fetch(new URL("/admin", f.service().url), {
    method: "POST",
  });
  assert.equal(response.status, 404);
  await response.body?.cancel();
  const grant = await f.issue();
  const forged = await invoke({
    issuer: f.worker,
    audience: f.service().principal,
    capability: {
      ...grant.capabilities[0]!,
      with: "urn:capvine:resource:other",
    },
    proofs: [grant],
    expiration: grant.expiration,
  }).delegate();
  await assert.rejects(
    createHttpTransport({ url: f.service().url })(await encodeGrant(forged)),
    PermissionDenied,
  );
  assert.equal(f.calls(), 0);
});

test("startup refuses authority replacement, retargeting, and concurrent state ownership", async (t) => {
  const f = await setup(t);
  await assert.rejects(startService(f.options), /EEXIST/);
  await f.service().close();
  await assert.rejects(
    startService({ ...f.options, owner: "other" }),
    /another authority or owner/,
  );
  await assert.rejects(
    startService({
      ...f.options,
      resources: [{ ...resource, target: { id: "other" } }],
    }),
    /persistent binding/,
  );
  const key = await readFile(join(f.directory, "authority.key"), "utf8");
  await writeFile(
    join(f.directory, "authority.key"),
    identity.format(await identity.generate()),
  );
  await assert.rejects(startService(f.options), /another authority or owner/);
  await writeFile(join(f.directory, "authority.key"), key);
  await f.restart();
  await f.admin().createTask("job");
  const grant = await f.issue();
  await f.restart([]);
  await assert.rejects(f.client().invoke(grant), PermissionDenied);
  await assert.rejects(f.issue(), /403/);
  assert.equal(f.calls(), 0);
});

test("private identity loading refuses broad modes, symlinks, and inconsistent key material", async (t) => {
  const f = await setup(t);
  await f.service().close();
  const path = join(f.directory, "authority.key");
  const original = await readFile(path, "utf8");
  await chmod(path, 0o644);
  await assert.rejects(loadIdentity(path), /private file/);
  await chmod(path, 0o600);
  const link = join(f.directory, "linked.key");
  await symlink(path, link);
  await assert.rejects(loadIdentity(link));
  const encoded = identity.encode(identity.parse(original));
  const other = identity.encode(await identity.generate());
  encoded.set(other.subarray(other.length - 32), encoded.length - 32);
  await writeFile(path, identity.format(identity.decode(encoded)));
  await assert.rejects(loadIdentity(path), /inconsistent/);
  await writeFile(path, original);
  await chmod(f.directory, 0o755);
  await assert.rejects(startService(f.options), /0700/);
  await chmod(f.directory, 0o700);
});

test("schema migration preserves legacy data and rejects unknown versions without changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capvine-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.db");
  let db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE capvine_records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind,id)); CREATE TABLE capvine_revocations (id TEXT PRIMARY KEY); CREATE TABLE capvine_audit (id TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO capvine_records VALUES ('resource', ?, ?)").run(
    resource.id,
    JSON.stringify(resource),
  );
  db.exec("INSERT INTO capvine_revocations VALUES ('revoked')");
  db.close();
  const store = new SqliteStore(path);
  assert.deepEqual(store.getResource(resource.id), resource);
  assert.equal(store.isRevoked("revoked"), true);
  assert.throws(
    () => store.bindService("did:key:other", "owner"),
    /migration review/,
  );
  store.close();
  db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => new SqliteStore(path), /schema version/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 99);
  db.close();
});

test("shutdown drains dispatched operations before closing persistent state", async (t) => {
  const f = await setup(t);
  await f.service().close();
  let release!: () => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await startService({
    ...f.options,
    operations: [
      {
        action: "record/read",
        resourceKind: "record",
        execute: async () => {
          started();
          await blocked;
          throw new Error("provider failure");
        },
      },
    ],
  });
  t.after(() => service.close());
  const admin = createAdministrationClient({
    url: service.administrationUrl,
    token: f.token,
  });
  await admin.createTask("job");
  const grant = await admin.issue({
    audience: f.worker,
    taskId: "job",
    resource: resource.id,
    action: "record/read",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const client = createClient({
    signer: f.worker,
    service: service.principal,
    transport: createHttpTransport({ url: service.url }),
  });
  const result = assert.rejects(client.invoke(grant), /500/);
  await dispatched;
  const closing = service.close();
  release();
  await result;
  await closing;
  const store = new SqliteStore(join(f.directory, "state.db"));
  assert.equal(store.audit().at(-1)?.reason, "handler_failed");
  assert.deepEqual(
    store
      .listAudit("owner", undefined, 25)
      .map((event) => [event.outcome, event.rootGrantId])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    [
      ["allowed", grant.cid.toString()],
      ["failed", grant.cid.toString()],
    ],
  );
  store.close();
});

test("owner inspection records delegated outcomes across restart and rejects worker access", async (t) => {
  const f = await setup(t);
  await f.admin().createTask("job");
  const parent = await f.issue();
  const childSigner = await identity.generate();
  const child = await f.client().delegate({
    grant: parent,
    audience: childSigner,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const childClient = () =>
    createClient({
      signer: childSigner,
      service: f.service().principal,
      transport: createHttpTransport({ url: f.service().url }),
    });
  const id = parent.cid.toString();
  const before = await f.admin().readGrant(id);
  assert.deepEqual(before, {
    id,
    audience: f.worker.did(),
    resource: resource.id,
    action: "record/read",
    service: f.service().principal.did(),
    task: { id: "job", active: true },
    expiresAt: parent.expiration,
    expired: false,
    revoked: false,
    workflow: null,
  });
  assert.deepEqual((await f.admin().listGrants()).grants, [before]);
  assert.equal(await childClient().invoke(child), "fixed");
  const request = await invoke({
    issuer: childSigner,
    audience: f.service().principal,
    capability: {
      ...child.capabilities[0]!,
      with: "urn:capvine:resource:other",
    },
    proofs: [child],
    expiration: child.expiration,
  }).delegate();
  await assert.rejects(
    createHttpTransport({ url: f.service().url })(await encodeGrant(request)),
    PermissionDenied,
  );
  await f.admin().revoke(id);
  await f.restart();
  await assert.rejects(childClient().invoke(child), PermissionDenied);
  assert.equal(f.calls(), 1);
  assert.equal((await f.admin().readGrant(id)).revoked, true);
  assert.equal((await f.admin().listGrants()).grants.length, 1);
  await assert.rejects(f.admin().readGrant(child.cid.toString()), /403/);
  await assert.rejects(
    createHttpTransport({ url: f.service().url })(new Uint8Array([1, 2, 3])),
  );
  const events = (await f.admin().listAudit()).events;
  assert.deepEqual(
    events.map((e) => e.outcome),
    ["allowed", "denied", "denied"],
  );
  assert.ok(events.every((e) => e.rootGrantId === id));
  for (const secret of [
    f.token,
    "fixed",
    Buffer.from(await encodeGrant(parent)).toString("base64"),
  ])
    assert.equal(JSON.stringify({ before, events }).includes(secret), false);
  const first = await f.admin().listAudit({ limit: 2 });
  assert.deepEqual(
    (await f.admin().listAudit({ after: first.nextCursor! })).events,
    events.slice(2),
  );
  await f.restart();
  assert.deepEqual((await f.admin().listAudit()).events, events);
  for (const method of ["grant.list", "audit.list", "grant.read"]) {
    const params = method === "grant.read" ? { id } : { after: "", limit: 25 };
    for (const token of [
      "wrong",
      Buffer.from(await encodeGrant(child)).toString("base64"),
    ]) {
      const response = await fetch(f.service().administrationUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method, params }),
      });
      assert.equal(response.status, 401);
      await response.body?.cancel();
    }
    const response = await fetch(new URL("/admin", f.service().url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
    });
    assert.equal(response.status, 404);
    await response.body?.cancel();
  }
  await assert.rejects(f.admin().listGrants({ limit: 101 }), /403/);
  await assert.rejects(f.admin().listAudit({ after: "invalid" }), /403/);
});

test("inspect CLI reads a private token file and outputs paginated metadata without leaking secrets", async (t) => {
  const f = await setup(t);
  await f.admin().createTask("job");
  const grant = await f.issue();
  await f.client().invoke(grant);
  const path = join(f.directory, "inspect.json");
  const config = {
    url: f.service().administrationUrl,
    tokenFile: join(f.directory, "admin.token"),
    limit: 1,
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const run = (kind: string) =>
    promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "inspect",
      path,
      kind,
    ]);
  assert.deepEqual(
    JSON.parse((await run("grants")).stdout),
    await f.admin().listGrants({ limit: 1 }),
  );
  const result = await run("audit");
  assert.deepEqual(
    JSON.parse(result.stdout),
    await f.admin().listAudit({ limit: 1 }),
  );
  assert.ok(!(result.stdout + result.stderr).includes(f.token));
  await chmod(path, 0o644);
  await assert.rejects(run("grants"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Capvine command failed/);
    assert.ok(!error.message.includes(f.token));
    return true;
  });
  await chmod(path, 0o600);
  for (const invalid of [
    { ...config, token: f.token },
    { ...config, tokenFile: "admin.token" },
    { ...config, limit: 101 },
    { ...config, url: "http://example.com/admin" },
  ]) {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(run("grants"));
  }
});
