import assert from "node:assert/strict";
import { test } from "node:test";
import { invoke } from "@ucanto/client";
import { createPostgresAdapter, type PostgresRecord } from "../src/postgres.ts";
import {
  createAuthority,
  createClient,
  encodeGrant,
  identity,
  MemoryStore,
  PermissionDenied,
} from "../src/index.ts";
import { startPostgresFixture } from "../examples/support/postgres.ts";

const record: PostgresRecord = {
  id: "urn:capvine:resource:record",
  schema: "app",
  table: "records",
  key: { column: "id", value: "one" },
  tenant: { column: "tenant", value: "team-a" },
  columns: ["id", "title"],
};

test("PostgreSQL adapter uses a real restricted database and exact record, tenant, connection, and projection", async (t) => {
  const database = await startPostgresFixture();
  t.after(() => database.stop());
  const options = {
    connectionId: "application",
    databaseId: "fixture-database",
    ownerId: "owner",
    connection: database.connection,
    records: [record],
  };
  const adapter = await createPostgresAdapter(options);
  t.after(() => adapter.close());
  const resource = adapter.resources[0]!;
  await database.admin.query(
    "CREATE TABLE app.inherited_records () INHERITS (app.records); INSERT INTO app.inherited_records VALUES ('one','team-a','Inherited data','hidden')",
  );
  assert.deepEqual(await adapter.operations[0]!.execute(resource), {
    id: "one",
    title: "Allowed record",
  });
  for (const target of [
    { ...resource.target, keyValue: "two" },
    { ...resource.target, tenantValue: "team-b" },
    { ...resource.target, connection: "other" },
    { ...resource.target, columns: '["secret"]' },
  ])
    await assert.rejects(
      adapter.operations[0]!.execute({ ...resource, target }),
      PermissionDenied,
    );
  await assert.rejects(
    createPostgresAdapter({ ...options, databaseId: "different-database" }),
    /identity mismatch/,
  );
  await assert.rejects(
    createPostgresAdapter({
      ...options,
      connection: { ...database.connection, user: "fixture_admin" },
    }),
    /restricted/,
  );
  await assert.rejects(
    createPostgresAdapter({
      ...options,
      records: [{ ...record, table: "records; DROP TABLE app.records" }],
    }),
    /identifier/,
  );
  const parameterized = await createPostgresAdapter({
    ...options,
    records: [{ ...record, key: { ...record.key, value: "one' OR true --" } }],
  });
  assert.equal(
    await parameterized.operations[0]!.execute(parameterized.resources[0]!),
    null,
  );
  await parameterized.close();
  const store = new MemoryStore();
  store.addResource(resource);
  store.addTask({ id: "job", ownerId: "owner", active: true });
  let dispatched = 0;
  const authority = createAuthority({
    signer: await identity.generate(),
    store,
    authorizeGrant: ({ actor }) => actor === "owner",
  });
  authority.registerOperation({
    ...adapter.operations[0]!,
    execute: async (r) => {
      dispatched++;
      return adapter.operations[0]!.execute(r);
    },
  });
  const worker = await identity.generate();
  const grant = await authority.issue({
    actor: "owner",
    audience: worker,
    resource: record.id,
    taskId: "job",
    action: "pg/record.read",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const client = createClient({
    signer: worker,
    service: authority.principal,
    transport: authority.execute,
  });
  assert.deepEqual(await client.invoke(grant), {
    id: "one",
    title: "Allowed record",
  });
  for (const capability of [
    { ...grant.capabilities[0]!, with: "urn:capvine:resource:other" as const },
    {
      ...grant.capabilities[0]!,
      nb: {
        ...(grant.capabilities[0]!.nb as Record<string, unknown>),
        action: "pg/record.write",
      },
    },
  ]) {
    const forged = await invoke({
      issuer: worker,
      audience: authority.principal,
      capability,
      proofs: [grant],
      expiration: grant.expiration,
    }).delegate();
    await assert.rejects(
      authority.execute(await encodeGrant(forged)),
      PermissionDenied,
    );
  }
  assert.equal(dispatched, 1);
  await database.admin.query("GRANT UPDATE ON app.records TO fixture_reader");
  await assert.rejects(
    adapter.operations[0]!.execute(resource),
    /read-only privileges/,
  );
  await database.admin.query(
    "REVOKE UPDATE ON app.records FROM fixture_reader",
  );
  await database.admin.query(
    "GRANT UPDATE (title) ON app.records TO fixture_reader",
  );
  await assert.rejects(
    adapter.operations[0]!.execute(resource),
    /read-only privileges/,
  );
  await database.admin.query(
    "REVOKE UPDATE (title) ON app.records FROM fixture_reader",
  );
  await database.admin.query(
    "UPDATE capvine.database_identity SET id = 'replaced-database'",
  );
  await assert.rejects(
    adapter.operations[0]!.execute(resource),
    /identity mismatch/,
  );
  await adapter.close();
});

test("PostgreSQL bounds data and lock waits and detects table replacement", async (t) => {
  const database = await startPostgresFixture();
  t.after(() => database.stop());
  const options = {
    connectionId: "application",
    databaseId: "fixture-database",
    ownerId: "owner",
    connection: database.connection,
    records: [record],
  };
  const adapter = await createPostgresAdapter(options);
  t.after(() => adapter.close());
  const read = () => adapter.operations[0]!.execute(adapter.resources[0]!);
  await database.admin.query(
    "UPDATE app.records SET title = repeat('x', 131073) WHERE id = 'one' AND tenant = 'team-a'",
  );
  await assert.rejects(read(), /read limit/);
  await database.admin.query(
    "UPDATE app.records SET title = 'Restored' WHERE id = 'one' AND tenant = 'team-a'",
  );
  const blocker = await database.admin.connect();
  try {
    await blocker.query(
      "BEGIN; LOCK TABLE app.records IN ACCESS EXCLUSIVE MODE",
    );
    await assert.rejects(read(), /lock timeout/);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  assert.deepEqual(await read(), { id: "one", title: "Restored" });
  await database.admin.query(
    "ALTER TABLE app.records RENAME TO original; CREATE TABLE app.records (LIKE app.original INCLUDING ALL); INSERT INTO app.records SELECT * FROM app.original; GRANT SELECT ON app.records TO fixture_reader",
  );
  await assert.rejects(read(), /identity changed/);
  await adapter.close();
});
