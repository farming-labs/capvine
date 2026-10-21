import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "@ucanto/client";
import { createWorkflowApprovals } from "../src/approvals.ts";
import { SqliteStore } from "../src/sqlite.ts";
import { readClaim } from "../src/profile.ts";
import {
  createAuthority,
  createClient,
  encodeGrant,
  identity,
  MemoryStore,
  PermissionDenied,
  type Grant,
} from "../src/index.ts";

async function setup(store = new MemoryStore(), policy = async () => true) {
  const signer = await identity.generate();
  const worker = await identity.generate();
  let calls = 0;
  const resource = "urn:capvine:resource:message" as const;
  store.addResource({
    id: resource,
    ownerId: "owner",
    kind: "message",
    target: {},
  });
  const authority = createAuthority({ signer, store, authorizeGrant: policy });
  authority.registerOperation({
    action: "message/read",
    resourceKind: "message",
    execute: async () => {
      calls++;
      return "content";
    },
  });
  const approvals = createWorkflowApprovals({
    authority,
    store,
    owner: "owner",
  });
  const input = {
    id: "daily-read",
    audience: worker,
    resource,
    action: "message/read",
    expiresAt: new Date(Date.now() + 86_400_000),
    maxGrantSeconds: 600,
  };
  const client = createClient({
    signer: worker,
    service: signer,
    transport: authority.execute,
  });
  const raw = async (grant: Grant, changes = {}, sender = worker) => {
    const request = await invoke({
      issuer: sender,
      audience: signer,
      proofs: [grant],
      capability: { ...grant.capabilities[0]!, ...changes },
      expiration: grant.expiration,
    }).delegate();
    return authority.execute(await encodeGrant(request));
  };
  return {
    approvals,
    input,
    client,
    raw,
    authority,
    store,
    worker,
    calls: () => calls,
  };
}

test("one approval issues fixed grants; disabling blocks previous roots, children, and renewal", async () => {
  const f = await setup();
  f.approvals.approve(f.input);
  const first = await f.approvals.issue(f.input.id);
  const second = await f.approvals.issue(f.input.id);
  assert.notEqual(first.cid.toString(), second.cid.toString());
  assert.equal(first.audience.did(), f.worker.did());
  assert.equal(first.capabilities[0]!.with, f.input.resource);
  assert.equal(readClaim(first).action, f.input.action);
  assert.ok(first.expiration <= Math.floor(Date.now() / 1000) + 600);
  assert.equal(await f.raw(first), "content");
  const childSigner = await identity.generate();
  const child = await f.client.delegate({
    grant: first,
    audience: childSigner,
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(await f.raw(child, {}, childSigner), "content");
  await assert.rejects(
    f.raw(second, { with: "urn:capvine:resource:other" }),
    PermissionDenied,
  );
  const claim = readClaim(second);
  await assert.rejects(
    f.raw(second, {
      nb: { task: claim.task, service: claim.service, action: "message/send" },
    }),
    PermissionDenied,
  );
  await assert.rejects(f.raw(second, {}, childSigner), PermissionDenied);
  f.approvals.disable(f.input.id);
  for (const grant of [first, second])
    await assert.rejects(f.raw(grant), PermissionDenied);
  await assert.rejects(f.raw(child, {}, childSigner), PermissionDenied);
  await assert.rejects(f.approvals.issue(f.input.id), PermissionDenied);
  assert.equal(f.approvals.read(f.input.id).active, false);
  assert.equal(f.calls(), 2);
});

test("approval expiry caps grant expiry and rejects renewal and raw invocations", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date() });
  const f = await setup();
  f.approvals.approve({ ...f.input, expiresAt: new Date(Date.now() + 10_000) });
  const grant = await f.approvals.issue(f.input.id);
  assert.equal(grant.expiration, Math.floor(Date.now() / 1000) + 10);
  assert.equal(await f.raw(grant), "content");
  t.mock.timers.tick(11_000);
  assert.equal(f.approvals.read(f.input.id).active, false);
  await assert.rejects(f.approvals.issue(f.input.id), PermissionDenied);
  await assert.rejects(f.raw(grant), PermissionDenied);
  assert.equal(f.calls(), 1);
});

test("approval records are immutable and owner-bound; current owner policy still gates issuance", async () => {
  const f = await setup(undefined, async () => false);
  const record = f.approvals.approve(f.input);
  record.action = "message/send";
  const copy = f.store.getApproval(f.input.id)!;
  copy.resource = "urn:capvine:resource:other";
  assert.equal(f.approvals.read(f.input.id).action, "message/read");
  assert.equal(f.approvals.read(f.input.id).resource, f.input.resource);
  assert.throws(() =>
    f.approvals.approve({ ...f.input, action: "message/send" }),
  );
  await assert.rejects(f.approvals.issue(f.input.id), PermissionDenied);
  const other = createWorkflowApprovals({
    authority: f.authority,
    store: f.store,
    owner: "other",
  });
  assert.throws(
    () => other.approve({ ...f.input, id: "other" }),
    PermissionDenied,
  );
  assert.throws(() => other.read(f.input.id), PermissionDenied);
  assert.throws(() => other.disable(f.input.id), PermissionDenied);
  await assert.rejects(other.issue(f.input.id), PermissionDenied);
  await assert.rejects(f.approvals.issue("unknown"), PermissionDenied);
  for (const maxGrantSeconds of [0, 3601, 1.5, NaN])
    assert.throws(
      () => f.approvals.approve({ ...f.input, id: "invalid", maxGrantSeconds }),
      PermissionDenied,
    );
  assert.equal(f.store.getApproval("invalid"), undefined);
  assert.equal(f.calls(), 0);
});

test("disabling an approval while its owner policy is pending prevents dispatch", async () => {
  let release!: (value: boolean) => void;
  let started!: () => void;
  const pending = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await setup(undefined, () => {
    started();
    return pending;
  });
  f.approvals.approve(f.input);
  const result = assert.rejects(
    f.approvals.issue(f.input.id),
    PermissionDenied,
  );
  await reached;
  f.approvals.disable(f.input.id);
  release(true);
  await result;
  await assert.rejects(f.approvals.issue(f.input.id), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("approval storage failures prevent issuance and a failed disable reports failure", async () => {
  class FailingStore extends MemoryStore {
    failing = false;
    override getApproval(id: string) {
      if (this.failing) throw new Error("Approval state unavailable");
      return super.getApproval(id);
    }
    override endTask(id: string) {
      throw new Error(`Cannot disable ${id}`);
    }
  }
  const store = new FailingStore();
  const f = await setup(store);
  f.approvals.approve(f.input);
  assert.throws(() => f.approvals.disable(f.input.id), /Cannot disable/);
  assert.equal(f.approvals.read(f.input.id).active, true);
  store.failing = true;
  await assert.rejects(f.approvals.issue(f.input.id), /state unavailable/);
  assert.equal(f.calls(), 0);
});

for (const backend of ["memory", "sqlite"]) {
  test(`${backend} atomically inserts approval and lifecycle task without replacing existing state`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "capvine-approval-"));
    const store =
      backend === "memory"
        ? new MemoryStore()
        : new SqliteStore(join(directory, "state.db"));
    t.after(async () => {
      if (store instanceof SqliteStore) store.close();
      await rm(directory, { recursive: true, force: true });
    });
    const record = {
      id: "daily",
      ownerId: "owner",
      audience: (await identity.generate()).did(),
      resource: "urn:capvine:resource:message" as const,
      action: "message/read",
      taskId: "approval:daily",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      maxGrantSeconds: 60,
    };
    store.addTask({ id: record.taskId, ownerId: "owner", active: false });
    assert.throws(() => store.addApproval(record));
    assert.equal(store.getApproval(record.id), undefined);
    assert.equal(store.getTask(record.taskId)?.active, false);
    const valid = { ...record, taskId: "approval:new" };
    store.addApproval(valid);
    assert.throws(() =>
      store.addApproval({ ...record, taskId: "approval:orphan" }),
    );
    assert.equal(store.getTask("approval:orphan"), undefined);
    assert.deepEqual(store.getApproval(record.id), valid);
    store.endTask(valid.taskId);
    assert.throws(() => store.addApproval(valid));
    assert.equal(store.getTask(valid.taskId)?.active, false);
  });
}
