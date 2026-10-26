import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  MemoryStore,
  createPermissionInspector,
  PermissionDenied,
  type InspectionStore,
  type GrantRecord,
  createAuthority,
  identity,
} from "../src/index.ts";
import { SqliteStore } from "../src/sqlite.ts";
import { createAdministrationHandler } from "../src/administration.ts";

function seed(store: InspectionStore) {
  for (const owner of ["owner", "other"]) {
    store.addResource({
      id: `urn:capvine:resource:${owner}`,
      ownerId: owner,
      kind: "record",
      target: { secret: "private resource content" },
    });
    store.addTask({ id: owner, ownerId: owner, active: true });
  }
  const grant: GrantRecord = {
    id: "a",
    taskId: "owner",
    resourceId: "urn:capvine:resource:owner",
    audience: "did:key:recipient",
    expiresAt: 1,
  };
  store.addGrant(grant);
  store.addGrant({
    ...grant,
    id: "b",
    action: "record/read",
    service: "did:key:service",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  store.addGrant({
    ...grant,
    id: "other",
    taskId: "other",
    resourceId: "urn:capvine:resource:other",
  });
  store.addGrant({ ...grant, id: "mixed-task", taskId: "other" });
  store.addGrant({
    ...grant,
    id: "mixed-resource",
    resourceId: "urn:capvine:resource:other",
  });
  for (const [id, rootGrantId, at] of [
    ["z", "a", 2],
    ["a", "b", 2],
    ["b", "a", 1],
    ["other", "other", 1],
    ["mixed-task", "mixed-task", 1],
    ["mixed-resource", "mixed-resource", 1],
    ["unknown", "unknown", 1],
  ] as const)
    store.appendAudit({
      id,
      rootGrantId,
      at,
      invocationId: null,
      outcome: "denied",
      reason: "provider secret",
    });
  store.appendAudit({
    id: "legacy",
    at: 1,
    invocationId: null,
    outcome: "allowed",
    reason: "authorized",
  });
}

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind} inspection pages owned records, preserves unknown legacy metadata and redacts outcomes`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "capvine-inspection-"));
    const store =
      kind === "memory"
        ? new MemoryStore()
        : new SqliteStore(join(dir, "state.db"));
    t.after(async () => {
      if (store instanceof SqliteStore) store.close();
      await rm(dir, { recursive: true, force: true });
    });
    seed(store);
    const inspect = createPermissionInspector({ store, owner: "owner" });
    const first = inspect.grants.list({ limit: 1 });
    assert.deepEqual(first, {
      grants: [
        {
          id: "a",
          audience: "did:key:recipient",
          resource: "urn:capvine:resource:owner",
          action: null,
          service: null,
          task: { id: "owner", active: true },
          expiresAt: 1,
          expired: true,
          revoked: false,
          workflow: null,
        },
      ],
      nextCursor: "a",
    });
    const second = inspect.grants.list({ limit: 1, after: first.nextCursor! });
    assert.equal(second.grants[0]!.action, "record/read");
    assert.equal(second.grants[0]!.service, "did:key:service");
    assert.equal(second.grants[0]!.expired, false);
    assert.equal(second.nextCursor, null);
    second.grants[0]!.task.active = false;
    assert.equal(inspect.grants.get("b").task.active, true);
    store.revoke("b");
    store.endTask("owner");
    assert.equal(inspect.grants.get("b").revoked, true);
    assert.equal(inspect.grants.get("b").task.active, false);
    for (const id of ["other", "mixed-task", "mixed-resource", "unknown"])
      assert.throws(() => inspect.grants.get(id), PermissionDenied);
    const events = [];
    let after: string | undefined;
    do {
      const page = inspect.audit.list({
        limit: 1,
        ...(after ? { after } : {}),
      });
      events.push(...page.events);
      after = page.nextCursor ?? undefined;
    } while (after);
    assert.deepEqual(
      events.map((e) => e.id),
      ["b", "a", "z"],
    );
    assert.ok(events.every((e) => e.reason === "other"));
    assert.ok(!JSON.stringify({ first, second, events }).includes("secret"));
    const other = createPermissionInspector({ store, owner: "other" });
    assert.deepEqual(
      other.grants.list().grants.map((g) => g.id),
      ["other"],
    );
    assert.deepEqual(
      other.audit.list().events.map((e) => e.id),
      ["other"],
    );
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { after: "x".repeat(1025) },
      { ownerId: "other" },
      { limit: null },
      { after: null },
    ]) {
      assert.throws(
        () => inspect.grants.list(input as never),
        PermissionDenied,
      );
      assert.throws(() => inspect.audit.list(input as never), PermissionDenied);
    }
    for (const after of [
      "invalid",
      Buffer.from('[1,"b",42]').toString("base64url"),
      Buffer.from('[1,"b"]').toString("base64url") + "=",
    ])
      assert.throws(() => inspect.audit.list({ after }), PermissionDenied);
  });
}

test("workflow status separates approval expiry, task disable, and root revocation", () => {
  const store = new MemoryStore();
  seed(store);
  store.addApproval({
    id: "daily",
    taskId: "approval:daily",
    ownerId: "owner",
    audience: "did:key:recipient",
    resource: "urn:capvine:resource:owner",
    action: "record/read",
    expiresAt: 1,
    maxGrantSeconds: 60,
  });
  store.addGrant({
    ...store.getGrant("b")!,
    id: "workflow",
    taskId: "approval:daily",
  });
  const inspect = createPermissionInspector({ store, owner: "owner" });
  assert.deepEqual(inspect.grants.get("workflow").workflow, {
    id: "daily",
    expiresAt: 1,
    expired: true,
    disabled: false,
  });
  store.endTask("approval:daily");
  const result = inspect.grants.get("workflow");
  assert.equal(result.workflow!.disabled, true);
  assert.equal(result.revoked, false);
  assert.equal(result.expired, false);
});

test("inspection rejects a store returning another owner's rows, malformed state, or failures", async (t) => {
  class LeakingStore extends MemoryStore {
    override listGrants() {
      return [this.getGrant("other")!];
    }
    override listAudit() {
      return [
        {
          id: "leak",
          rootGrantId: "other",
          invocationId: null,
          at: 1,
          outcome: "allowed" as const,
          reason: "authorized",
        },
      ];
    }
  }
  const store = new LeakingStore();
  seed(store);
  const inspect = createPermissionInspector({ store, owner: "owner" });
  assert.throws(() => inspect.grants.list(), PermissionDenied);
  assert.throws(() => inspect.audit.list(), PermissionDenied);
  store.addGrant({ ...store.getGrant("b")!, id: "malformed", expiresAt: NaN });
  assert.throws(
    () => inspect.grants.get("malformed"),
    /Invalid inspection state/,
  );
  const dir = await mkdtemp(join(tmpdir(), "capvine-inspection-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new SqliteStore(join(dir, "state.db"));
  seed(db);
  db.close();
  const unavailable = createPermissionInspector({ store: db, owner: "owner" });
  assert.throws(() => unavailable.grants.list());
  assert.throws(() => unavailable.grants.get("a"));
  assert.throws(() => unavailable.audit.list());
});

test("administration reports unavailable inspection storage as an error, never an empty page", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capvine-inspection-http-"));
  const store = new SqliteStore(join(dir, "state.db"));
  seed(store);
  const token = randomBytes(32).toString("base64url");
  const authority = createAuthority({
    signer: await identity.generate(),
    store,
    authorizeGrant: () => false,
  });
  const server = createServer(
    createAdministrationHandler({
      authority,
      store,
      owner: "owner",
      token,
      audit: () => store.audit(),
      inspection: createPermissionInspector({ store, owner: "owner" }),
    }),
  );
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  store.close();
  for (const [method, params] of [
    ["grant.list", { after: "", limit: 25 }],
    ["grant.read", { id: "a" }],
    ["audit.list", { after: "", limit: 25 }],
  ] as const) {
    const response: Response = await fetch(
      `http://127.0.0.1:${address.port}/admin`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method, params }),
      },
    );
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "administration_failed" });
  }
});
