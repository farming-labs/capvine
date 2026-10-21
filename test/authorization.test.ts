import assert from "node:assert/strict";
import { test } from "node:test";
import * as Client from "@ucanto/client";
import { Absentee } from "@ucanto/principal";
import {
  createAuthority,
  createClient,
  encodeGrant,
  decodeGrant,
  identity,
  MemoryStore,
  PermissionDenied,
  type Grant,
  type StateStore,
  type Identity,
  type Principal,
} from "../src/index.ts";

async function fixture(store: StateStore = new MemoryStore()) {
  const service = await identity.generate();
  const a = await identity.generate();
  const b = await identity.generate();
  let calls = 0;
  for (const id of ["issue42", "issue43"]) {
    store.addResource({
      id: `urn:capvine:resource:${id}`,
      ownerId: "demo-owner",
      kind: "github.issue",
      target: { issue: id },
    });
  }
  for (const id of ["task1", "task2"])
    store.addTask({ id, ownerId: "demo-owner", active: true });
  const authority = createAuthority({
    signer: service,
    store,
    authorizeGrant: ({ actor, resource, task }) =>
      actor === resource.ownerId && actor === task.ownerId,
  });
  for (const action of ["github/issue.read", "github/comment.post"]) {
    authority.registerOperation({
      action,
      resourceKind: "github.issue",
      execute: async (resource) => {
        calls++;
        return { issue: resource.target.issue! };
      },
    });
  }
  const parent = await authority.issue({
    actor: "demo-owner",
    audience: a,
    taskId: "task1",
    resource: "urn:capvine:resource:issue42",
    action: "github/issue.read",
    expiresAt: new Date(Date.now() + 600_000),
  });
  const clientA = createClient({
    signer: a,
    service: authority.principal,
    transport: authority.execute,
  });
  const clientB = createClient({
    signer: b,
    service: authority.principal,
    transport: authority.execute,
  });
  const child = await clientA.delegate({
    grant: parent,
    audience: b,
    expiresAt: new Date(Date.now() + 300_000),
  });
  const claim = {
    can: "capvine/invoke" as const,
    with: "urn:capvine:resource:issue42" as const,
    nb: { action: "github/issue.read", task: "task1", service: service.did() },
  };
  async function send(
    capability = claim,
    proofs: Grant[] = [child],
    issuer: Identity = b,
    audience: Principal = service,
    expiration = child.expiration,
  ) {
    const request = await Client.invoke({
      issuer,
      audience,
      capability,
      proofs,
      expiration,
      nonce: crypto.randomUUID(),
    }).delegate();
    return authority.execute(await encodeGrant(request));
  }
  return {
    service,
    a,
    b,
    store,
    authority,
    parent,
    child,
    clientA,
    clientB,
    claim,
    send,
    calls: () => calls,
  };
}

test("a serialized parent-child chain reaches exactly the bound resource", async () => {
  const f = await fixture();
  const restored = await decodeGrant(await encodeGrant(f.child));
  assert.deepEqual(await f.clientB.invoke(restored), { issue: "issue42" });
  assert.equal(f.calls(), 1);
});

test("the supported proof archive retains the pinned UCAN version and exact capability", async () => {
  const f = await fixture();
  const restored = await decodeGrant(await encodeGrant(f.child));
  assert.equal(restored.version, "0.9.1");
  assert.deepEqual(restored.capabilities, [f.claim]);
  assert.equal(restored.cid.toString(), f.child.cid.toString());
});

for (const failure of ["task", "grant", "revocation", "audit"] as const) {
  test(`storage failure during ${failure} checks denies a raw invocation before dispatch`, async () => {
    class FailingStore extends MemoryStore {
      failing = false;
      override getTask(id: string) {
        if (this.failing && failure === "task")
          throw new Error("State unavailable");
        return super.getTask(id);
      }
      override getGrant(id: string) {
        if (this.failing && failure === "grant")
          throw new Error("State unavailable");
        return super.getGrant(id);
      }
      override isRevoked(id: string) {
        if (this.failing && failure === "revocation")
          throw new Error("State unavailable");
        return super.isRevoked(id);
      }
      override appendAudit(event: Parameters<MemoryStore["appendAudit"]>[0]) {
        if (this.failing && failure === "audit")
          throw new Error("State unavailable");
        super.appendAudit(event);
      }
    }
    const store = new FailingStore();
    const f = await fixture(store);
    store.failing = true;
    await assert.rejects(f.send());
    assert.equal(f.calls(), 0);
    store.failing = false;
    assert.deepEqual(await f.send(), { issue: "issue42" });
    assert.equal(f.calls(), 1);
  });
}

test("issuance does not return a root grant when persistence fails", async () => {
  class FailingStore extends MemoryStore {
    failing = false;
    override addGrant(record: Parameters<MemoryStore["addGrant"]>[0]) {
      if (this.failing) throw new Error("Grant persistence failed");
      super.addGrant(record);
    }
  }
  const store = new FailingStore();
  const f = await fixture(store);
  store.failing = true;
  await assert.rejects(
    f.authority.issue({
      actor: "demo-owner",
      audience: f.a,
      taskId: "task1",
      resource: "urn:capvine:resource:issue42",
      action: "github/issue.read",
      expiresAt: new Date(Date.now() + 60_000),
    }),
    /persistence failed/,
  );
  assert.equal(f.calls(), 0);
});

test("owner policy rejects another user's grant request", async () => {
  const f = await fixture();
  await assert.rejects(
    f.authority.issue({
      actor: "mallory",
      audience: f.a,
      taskId: "task1",
      resource: "urn:capvine:resource:issue42",
      action: "github/issue.read",
      expiresAt: new Date(Date.now() + 60_000),
    }),
    PermissionDenied,
  );
  assert.equal(f.calls(), 0);
});

for (const change of ["resource", "action", "task", "service"] as const) {
  test(`server rejects changing ${change}, even when the caller bypasses the SDK`, async () => {
    const f = await fixture();
    const claim = structuredClone(f.claim);
    if (change === "resource")
      Object.assign(claim, { with: "urn:capvine:resource:issue43" });
    if (change === "action") claim.nb.action = "github/comment.post";
    if (change === "task") claim.nb.task = "task2";
    if (change === "service") claim.nb.service = f.a.did();
    await assert.rejects(f.send(claim), PermissionDenied);
    assert.equal(f.calls(), 0);
  });
}

test("server rejects a child that expands its parent's authority", async () => {
  const f = await fixture();
  const changed = {
    ...f.claim,
    nb: { ...f.claim.nb, action: "github/comment.post" },
  };
  const forged = await Client.delegate({
    issuer: f.a,
    audience: f.b,
    capabilities: [changed],
    proofs: [f.parent],
    expiration: f.child.expiration,
  });
  await assert.rejects(f.send(changed, [forged]), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("server rejects a child expiry beyond its parent", async () => {
  const f = await fixture();
  const forged = await Client.delegate({
    issuer: f.a,
    audience: f.b,
    capabilities: [f.claim],
    proofs: [f.parent],
    expiration: f.parent.expiration + 100,
  });
  await assert.rejects(f.send(f.claim, [forged]), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("server rejects a request signed by someone other than the grant recipient", async () => {
  const f = await fixture();
  await assert.rejects(f.send(f.claim, [f.child], f.a), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("server rejects an unsigned impersonation of the grant recipient", async () => {
  const f = await fixture();
  const request = await Client.invoke({
    issuer: Absentee.from({ id: f.b.did() }),
    audience: f.service,
    capability: f.claim,
    proofs: [f.child],
    expiration: f.child.expiration,
  }).delegate();
  await assert.rejects(
    f.authority.execute(await encodeGrant(request)),
    PermissionDenied,
  );
  assert.equal(f.calls(), 0);
});

test("server rejects a different receiving service", async () => {
  const f = await fixture();
  await assert.rejects(f.send(f.claim, [f.child], f.b, f.a), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("server rejects an expired invocation", async () => {
  const f = await fixture();
  await assert.rejects(
    f.send(
      f.claim,
      [f.child],
      f.b,
      f.service,
      Math.floor(Date.now() / 1000) - 10,
    ),
    PermissionDenied,
  );
  assert.equal(f.calls(), 0);
});

test("server rejects an expired parent even with a fresh invocation", async () => {
  const f = await fixture();
  const expired = await Client.delegate({
    issuer: f.a,
    audience: f.b,
    capabilities: [f.claim],
    proofs: [f.parent],
    expiration: Math.floor(Date.now() / 1000) - 10,
  });
  await assert.rejects(f.send(f.claim, [expired]), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("revoking the parent prevents subsequent child executions", async () => {
  const f = await fixture();
  await f.clientB.invoke(f.child);
  f.store.revoke(f.parent.cid.toString());
  await assert.rejects(f.clientB.invoke(f.child), PermissionDenied);
  assert.equal(f.calls(), 1);
});

test("revoking the child leaves the independent parent usable", async () => {
  const f = await fixture();
  f.store.revoke(f.child.cid.toString());
  await assert.rejects(f.clientB.invoke(f.child), PermissionDenied);
  await f.clientA.invoke(f.parent);
  assert.equal(f.calls(), 1);
});

test("ending the task invalidates its otherwise valid grants", async () => {
  const f = await fixture();
  f.store.endTask("task1");
  await assert.rejects(f.clientB.invoke(f.child), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("knowing the resource URI without a delegation grants no access", async () => {
  const f = await fixture();
  await assert.rejects(f.send(f.claim, []), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("self-issued roots cannot substitute for owner authorization", async () => {
  const f = await fixture();
  const fakeRoot = await Client.delegate({
    issuer: f.a,
    audience: f.b,
    capabilities: [f.claim],
    expiration: f.child.expiration,
  });
  await assert.rejects(f.send(f.claim, [fakeRoot]), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("the resource binding cannot be replaced or mutated through a returned object", async () => {
  const f = await fixture();
  const resource = f.store.getResource(f.claim.with)!;
  resource.target.issue = "issue43";
  assert.throws(() => f.store.addResource(resource));
  assert.deepEqual(await f.clientB.invoke(f.child), { issue: "issue42" });
});

test("invalid and oversized archives never reach a handler", async () => {
  const f = await fixture();
  await assert.rejects(
    f.authority.execute(new Uint8Array([1, 2, 3])),
    PermissionDenied,
  );
  await assert.rejects(
    f.authority.execute(new Uint8Array(65_537)),
    PermissionDenied,
  );
  assert.equal(f.calls(), 0);
});

test("deep proof chains fail closed", async () => {
  const f = await fixture();
  let grant = f.child;
  for (let i = 0; i < 8; i++) {
    grant = await Client.delegate({
      issuer: f.b,
      audience: f.b,
      capabilities: [f.claim],
      proofs: [grant],
      expiration: grant.expiration,
    });
  }
  await assert.rejects(f.send(f.claim, [grant]), PermissionDenied);
  assert.equal(f.calls(), 0);
});

test("audit events record outcomes without storing tool results", async () => {
  const store = new MemoryStore();
  const f = await fixture(store);
  await f.clientB.invoke(f.child);
  store.revoke(f.parent.cid.toString());
  await assert.rejects(f.clientB.invoke(f.child));
  assert.deepEqual(
    store.audit().map((event) => event.outcome),
    ["allowed", "denied"],
  );
  assert.equal(JSON.stringify(store.audit()).includes("issue42"), false);
});
