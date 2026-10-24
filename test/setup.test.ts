import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "@ucanto/client";
import { createCapvine, workflow } from "../src/setup.ts";
import {
  defineResource,
  filesystem,
  gmail,
  slackMessages,
} from "../src/resources.ts";
import { writePrivateFile } from "../src/identity-file.ts";
import { loadWorker } from "../src/worker.ts";
import { createHttpTransport } from "../src/http.ts";
import {
  decodeGrant,
  encodeGrant,
  identity,
  PermissionDenied,
} from "../src/index.ts";
import { startProviderFixture } from "../examples/accounts/provider-fixture.ts";
import { startSlackFixture } from "../examples/slack/provider-fixture.ts";
import { messages } from "../examples/plugins/message-resource.ts";
import { oidc } from "../src/providers.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "capvine-setup-test-"));
  const data = join(directory, "data");
  await mkdir(data, { mode: 0o700 });
  await writePrivateFile(join(data, "one.txt"), "First file");
  await writePrivateFile(join(data, "two.txt"), "Second file");
  const resource = "urn:capvine:resource:one" as const;
  const plugin = (
    path = "one.txt",
    id = resource as `urn:capvine:resource:${string}`,
  ) => filesystem({ root: data, connectionId: "files", files: [{ id, path }] });
  const options = {
    directory: join(directory, "app"),
    ownerId: "owner",
    port: 0,
    resources: [plugin()],
    workflows: [workflow({ id: "read-file", resource, action: "fs/read" })],
  };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, data, resource, plugin, options };
}

test("setup composes repeated resource plugins and rejects raw signed cross-resource requests", async (t) => {
  const f = await fixture(t);
  const second = "urn:capvine:resource:two" as const;
  const app = await createCapvine({
    ...f.options,
    resources: [f.plugin(), f.plugin("two.txt", second)],
    workflows: [
      ...f.options.workflows,
      workflow({ id: "read-second", resource: second, action: "fs/read" }),
    ],
  });
  try {
    const approval = await app.workflows.approve("read-file");
    const job = await app.workflows.provision(approval.id);
    const worker = await loadWorker(job.path);
    const first = await worker.invoke();
    assert.match(JSON.stringify(first), /First file/);
    const secondApproval = await app.workflows.approve("read-second");
    const secondJob = await app.workflows.provision(secondApproval.id);
    assert.match(
      JSON.stringify(await (await loadWorker(secondJob.path)).invoke()),
      /Second file/,
    );
    const saved = JSON.parse(await readFile(job.path, "utf8"));
    const grant = await decodeGrant(Buffer.from(saved.grant, "base64"));
    const forged = await invoke({
      issuer: identity.parse(saved.signer),
      audience: app.service.principal,
      capability: { ...grant.capabilities[0]!, with: second },
      proofs: [grant],
      expiration: grant.expiration,
    }).delegate();
    await assert.rejects(
      createHttpTransport({ url: app.service.url })(await encodeGrant(forged)),
      PermissionDenied,
    );
    await app.workflows.disable(approval.id);
    await assert.rejects(worker.invoke(), PermissionDenied);
    assert.match(
      JSON.stringify(await (await loadWorker(secondJob.path)).invoke()),
      /Second file/,
    );
    await assert.rejects(
      app.start({ resources: [f.plugin()] }),
      /already started/,
    );
  } finally {
    await app.close();
  }
});

test("setup retains identity and approvals, renews after restart and refuses to retarget a resource", async (t) => {
  const f = await fixture(t);
  let app = await createCapvine(f.options);
  try {
    const principal = app.service.principal.did();
    const approval = await app.workflows.approve("read-file");
    const job = await app.workflows.provision(approval.id);
    const port = Number(new URL(app.service.url).port);
    await app.close();
    await assert.rejects(
      createCapvine({ ...f.options, port, resources: [f.plugin("two.txt")] }),
      /conflicts with persistent binding/,
    );
    app = await createCapvine({ ...f.options, port });
    assert.equal(app.service.principal.did(), principal);
    await app.workflows.renew(job.id);
    assert.match(
      JSON.stringify(await (await loadWorker(job.path)).invoke()),
      /First file/,
    );
    await app.workflows.disable(approval.id);
    await app.close();
    app = await createCapvine({ ...f.options, port });
    await assert.rejects(
      (await loadWorker(job.path)).invoke(),
      PermissionDenied,
    );
    await assert.rejects(app.workflows.provision(approval.id));
  } finally {
    await app.close();
  }
});

for (const kind of ["google", "slack"] as const) {
  test(`setup connects ${kind} before resource registration and keeps provider credentials out of workers`, async (t) => {
    const f = await fixture(t);
    const provider =
      kind === "google"
        ? await startProviderFixture()
        : await startSlackFixture();
    const app = await createCapvine({
      directory: f.options.directory,
      ownerId: "owner",
      providers: [provider.provider()],
      port: 0,
    });
    try {
      const sessionId = randomBytes(32).toString("base64url");
      const pending = await app.accounts.begin({
        ownerId: "owner",
        sessionId,
        connectionId: "account",
        provider: kind,
      });
      const connected = await app.accounts.complete({
        ownerId: "owner",
        sessionId,
        callback: await provider.authorize(pending.url),
      });
      const binding = {
        id: f.resource,
        connectionId: connected.id,
        subject: connected.subject!,
      };
      const resource =
        "gmailFetch" in provider
          ? gmail({
              messages: [{ ...binding, messageId: "a42" }],
              fetch: provider.gmailFetch,
            })
          : slackMessages({
              messages: [
                {
                  ...binding,
                  channelId: "CFIXTURE",
                  timestamp: "1700000000.000042",
                },
              ],
              fetch: provider.fetch,
            });
      await app.start({
        resources: [resource],
        workflows: [
          workflow({
            id: "read-message",
            resource: f.resource,
            action:
              kind === "google" ? "gmail/message.read" : "slack/message.read",
          }),
        ],
      });
      const approval = await app.workflows.approve("read-message");
      const job = await app.workflows.provision(approval.id);
      assert.ok(await (await loadWorker(job.path)).invoke());
      assert.equal(provider.counts.reads, 1);
      assert.equal(provider.counts.refreshes, 1);
      const assignment = await readFile(job.path, "utf8");
      for (const secret of provider.secrets())
        assert.equal(assignment.includes(secret), false);
      app.accounts.disconnect("owner", connected.id);
      await assert.rejects((await loadWorker(job.path)).invoke());
      assert.equal(provider.counts.reads, 1);
    } finally {
      await app.close();
      await provider.close();
    }
  });
}

test("configuration failures close plugins exactly once and leave state available for a corrected start", async (t) => {
  const f = await fixture(t);
  const closed: string[] = [];
  const observed = (name: string, kind = "record", action = "record/read") =>
    defineResource({
      name,
      open: ({ ownerId }) => ({
        resources: [
          {
            id: `urn:capvine:resource:${name}`,
            ownerId,
            kind,
            target: { id: name },
          },
        ],
        operations: [{ action, resourceKind: kind, execute: async () => name }],
        close: async () => {
          closed.push(name);
        },
      }),
    });
  await assert.rejects(
    createCapvine({
      ...f.options,
      resources: [observed("one"), observed("two")],
      workflows: [
        workflow({
          id: "bad",
          resource: "urn:capvine:resource:missing",
          action: "record/read",
        }),
      ],
    }),
    /unregistered/,
  );
  assert.deepEqual(closed.splice(0), ["two", "one"]);
  await assert.rejects(
    createCapvine({
      ...f.options,
      resources: [observed("one"), observed("one")],
      workflows: [],
    }),
    /unique IDs/,
  );
  assert.deepEqual(closed.splice(0), ["one", "one"]);
  await assert.rejects(
    createCapvine({
      ...f.options,
      resources: [observed("one"), observed("two", "different")],
      workflows: [],
    }),
    /different resource kinds/,
  );
  assert.deepEqual(closed.splice(0), ["two", "one"]);
  await assert.rejects(
    createCapvine({
      ...f.options,
      resources: [
        observed("one"),
        defineResource({
          name: "broken",
          open() {
            throw new Error("Unavailable");
          },
        }),
      ],
      workflows: [],
    }),
    /Unavailable/,
  );
  assert.deepEqual(closed.splice(0), ["one"]);
  await assert.rejects(
    createCapvine({
      ...f.options,
      resources: [observed("one"), observed("two", "record", "other/read")],
      workflows: [
        workflow({
          id: "bad",
          resource: "urn:capvine:resource:two",
          action: "record/read",
        }),
      ],
    }),
    /unregistered/,
  );
  assert.deepEqual(closed.splice(0), ["two", "one"]);
  const app = await createCapvine(f.options);
  await app.close();
});

test("setup fails closed on missing keys, partial state, ownership mismatch and concurrent ownership", async (t) => {
  const f = await fixture(t);
  const app = await createCapvine(f.options);
  const keyPath = join(f.options.directory, "accounts.key");
  const original = await readFile(keyPath);
  assert.equal((await stat(f.options.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  try {
    await assert.rejects(createCapvine(f.options), /EEXIST/);
  } finally {
    await app.close();
  }
  await assert.rejects(
    createCapvine({ ...f.options, ownerId: "other" }),
    /different owner/,
  );
  await assert.rejects(
    createCapvine({ ...f.options, encryptionKey: randomBytes(32) }),
    /key configuration/,
  );
  assert.deepEqual(await readFile(keyPath), original);
  await rm(keyPath);
  await assert.rejects(createCapvine(f.options), /ENOENT/);
  await assert.rejects(readFile(keyPath), /ENOENT/);
  const partial = join(f.directory, "partial");
  await mkdir(partial, { mode: 0o700 });
  await assert.rejects(
    createCapvine({ ...f.options, directory: partial }),
    /not initialized/,
  );
  const linked = join(f.directory, "linked");
  await symlink(f.options.directory, linked);
  await assert.rejects(
    createCapvine({ ...f.options, directory: linked }),
    /directory/,
  );
  await chmod(partial, 0o755);
  await assert.rejects(
    createCapvine({ ...f.options, directory: partial }),
    /0700/,
  );
});

test("external account encryption keys remain external and the wrong key cannot reopen account state", async (t) => {
  const f = await fixture(t);
  const provider = await startProviderFixture();
  const options = {
    directory: f.options.directory,
    ownerId: "owner",
    providers: [provider.provider()],
    encryptionKey: randomBytes(32),
  };
  try {
    const app = await createCapvine(options);
    await app.close();
    await assert.rejects(
      readFile(join(options.directory, "accounts.key")),
      /ENOENT/,
    );
    await assert.rejects(
      createCapvine({ ...options, encryptionKey: randomBytes(32) }),
    );
    const reopened = await createCapvine(options);
    await reopened.close();
  } finally {
    await provider.close();
  }
});

test("setup rejects misspelled settings and duplicate providers before creating persistent state", async (t) => {
  const f = await fixture(t);
  const provider = await startProviderFixture();
  try {
    await assert.rejects(
      createCapvine({ ...f.options, provider: [] } as Parameters<
        typeof createCapvine
      >[0]),
      /Unknown/,
    );
    await assert.rejects(
      createCapvine({
        ...f.options,
        providers: [provider.provider(), provider.provider()],
      }),
      /unique IDs/,
    );
    assert.throws(
      () =>
        workflow({
          id: "read",
          resource: f.resource,
          action: "fs/read",
          workerSecond: 60,
        } as Parameters<typeof workflow>[0]),
      /Invalid workflow/,
    );
    await assert.rejects(stat(f.options.directory), /ENOENT/);
  } finally {
    await provider.close();
  }
});

test("setup refuses to recreate missing or emptied credential state after initialization", async (t) => {
  const f = await fixture(t);
  const app = await createCapvine(f.options);
  const options = { ...f.options, port: Number(new URL(app.service.url).port) };
  await app.close();
  const path = join(f.options.directory, "accounts/accounts.db");
  const original = await readFile(path);
  await rm(path);
  await assert.rejects(
    createCapvine(options),
    /Credential store could not be opened/,
  );
  await assert.rejects(stat(path), /ENOENT/);
  await writeFile(path, "", { mode: 0o600 });
  await assert.rejects(
    createCapvine(options),
    /Credential store could not be opened/,
  );
  assert.equal((await stat(path)).size, 0);
  await writeFile(path, original);
  const reopened = await createCapvine(options);
  await reopened.close();
});

test("shutdown drains pending plugin startup before releasing ownership", async (t) => {
  const f = await fixture(t);
  const app = await createCapvine({
    directory: f.options.directory,
    ownerId: "owner",
    port: 0,
  });
  let unblock!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let closed = 0;
  const starting = app.start({
    resources: [
      defineResource({
        name: "slow",
        async open() {
          entered();
          await gate;
          const adapter = await f
            .plugin()
            .open({ ownerId: "owner", accounts: undefined });
          return {
            ...adapter,
            async close() {
              closed++;
              await adapter.close();
            },
          };
        },
      }),
    ],
  });
  await waiting;
  const stopping = app.close();
  await assert.rejects(app.start({ resources: [f.plugin()] }), /closing/);
  await assert.rejects(createCapvine(f.options), /EEXIST/);
  unblock();
  await starting;
  await stopping;
  await app.close();
  assert.equal(closed, 1);
  const reopened = await createCapvine(f.options);
  await reopened.close();
});

test("custom OIDC resource starter rejects changed targets, redirects and oversized provider results", async (t) => {
  const f = await fixture(t);
  const provider = await startProviderFixture({
    scopes: ["openid", "messages:read"],
  });
  const app = await createCapvine({
    directory: f.options.directory,
    ownerId: "owner",
    port: 0,
    providers: [oidc({ ...provider.providerOptions(), id: "custom" })],
  });
  try {
    const sessionId = randomBytes(32).toString("base64url");
    const pending = await app.accounts.begin({
      ownerId: "owner",
      sessionId,
      connectionId: "custom-account",
      provider: "custom",
    });
    const connected = await app.accounts.complete({
      ownerId: "owner",
      sessionId,
      callback: await provider.authorize(pending.url),
    });
    await app.start({
      resources: [
        messages({
          origin: provider.issuer,
          allowLoopbackHttp: true,
          provider: "custom",
          connectionId: connected.id,
          subject: connected.subject!,
          messages: [{ id: f.resource, messageId: "a42" }],
        }),
      ],
      workflows: [
        workflow({
          id: "read-message",
          resource: f.resource,
          action: "example/message.read",
        }),
      ],
    });
    const approval = await app.workflows.approve("read-message");
    const job = await app.workflows.provision(approval.id);
    const worker = await loadWorker(job.path);
    assert.deepEqual(await worker.invoke(), {
      id: "a42",
      snippet: "The report is ready.",
    });
    for (const control of [
      "wrongMessage",
      "redirectMessage",
      "oversizedMessage",
    ] as const) {
      provider.controls[control] = true;
      await assert.rejects(worker.invoke());
      provider.controls[control] = false;
    }
    assert.deepEqual(await worker.invoke(), {
      id: "a42",
      snippet: "The report is ready.",
    });
  } finally {
    await app.close();
    await provider.close();
  }
});
