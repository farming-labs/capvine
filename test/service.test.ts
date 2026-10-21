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
  store.close();
});
