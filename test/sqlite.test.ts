import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuthority,
  createClient,
  identity,
  PermissionDenied,
} from "../src/index.ts";
import { SqliteStore } from "../src/sqlite.ts";

test("restart preserves resources, task state, grants, audit, and parent revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capvine-"));
  const path = join(dir, "state.db");
  let store: SqliteStore | undefined;
  try {
    const service = await identity.generate();
    const a = await identity.generate();
    const b = await identity.generate();
    store = new SqliteStore(path);
    store.addResource({
      id: "urn:capvine:resource:42",
      ownerId: "simon",
      kind: "issue",
      target: { issue: "42" },
    });
    store.addTask({ id: "task", ownerId: "simon", active: true });
    let calls = 0;
    const createServer = (state: SqliteStore) => {
      const authority = createAuthority({
        signer: service,
        store: state,
        authorizeGrant: ({ actor, resource }) => actor === resource.ownerId,
      });
      authority.registerOperation({
        action: "issue/read",
        resourceKind: "issue",
        execute: async (resource) => {
          calls++;
          return resource.target.issue!;
        },
      });
      return authority;
    };
    let server = createServer(store);
    const parent = await server.issue({
      actor: "simon",
      audience: a,
      taskId: "task",
      resource: "urn:capvine:resource:42",
      action: "issue/read",
      expiresAt: new Date(Date.now() + 600_000),
    });
    const clientA = createClient({
      signer: a,
      service: server.principal,
      transport: (bytes) => server.execute(bytes),
    });
    const child = await clientA.delegate({
      grant: parent,
      audience: b,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const clientB = createClient({
      signer: b,
      service: server.principal,
      transport: (bytes) => server.execute(bytes),
    });
    assert.equal(await clientB.invoke(child), "42");
    store.close();
    store = new SqliteStore(path);
    server = createServer(store);
    assert.equal(await clientB.invoke(child), "42");
    store.revoke(parent.cid.toString());
    store.close();
    store = new SqliteStore(path);
    server = createServer(store);
    await assert.rejects(clientB.invoke(child), PermissionDenied);
    assert.equal(calls, 2);
    assert.equal(store.getTask("task")?.active, true);
    assert.equal(store.audit().length, 3);
    store.endTask("task");
    store.close();
    store = new SqliteStore(path);
    assert.equal(store.getTask("task")?.active, false);
    assert.throws(() =>
      store!.addResource({
        id: "urn:capvine:resource:42",
        ownerId: "other",
        kind: "issue",
        target: {},
      }),
    );
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
