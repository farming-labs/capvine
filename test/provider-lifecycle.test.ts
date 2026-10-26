import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, chmod, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCapvine } from "../src/setup.ts";
import type { createApplication } from "../src/application.ts";
import { createCapvineClient } from "../src/owner-client.ts";
import { gmail, slackMessages } from "../src/plugins.ts";
import { toNodeHandler } from "../src/node.ts";
import { identity, decodeGrant } from "../src/index.ts";
import { loadWorker, provisionWorker } from "../src/worker.ts";
import { startProviderFixture } from "../examples/accounts/provider-fixture.ts";
import { startSlackFixture } from "../examples/slack/provider-fixture.ts";
import {
  captureWorker,
  compareWorkers,
} from "../examples/provider-validation/lifecycle.ts";

async function fixture(t: TestContext, kind: "google" | "slack" = "google") {
  const root = await mkdtemp(join(tmpdir(), "capvine-lifecycle-"));
  let app: Awaited<ReturnType<typeof createApplication>>;
  let failingInvocation = 0;
  let invocations = 0;
  const server = createServer((request, response) => {
    if (
      request.url === "/api/capvine/invoke" &&
      ++invocations === failingInvocation
    ) {
      request.resume();
      response.writeHead(503);
      response.end();
      return;
    }
    void toNodeHandler(app, { baseURL })(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const redirectUri = `${baseURL}/api/capvine/callback`;
  const provider =
    kind === "google"
      ? await startProviderFixture({ redirectUri })
      : await startSlackFixture({ redirectUri });
  const sessionId = randomBytes(32).toString("base64url");
  const options = {
    baseURL,
    ownerId: "owner",
    storage: { directory: join(root, "state") },
    authenticate: (request: Request) =>
      request.headers.get("cookie") === `session=${sessionId}`
        ? { ownerId: "owner", sessionId }
        : null,
    providers: [provider.provider()],
    plugins: [
      "gmailFetch" in provider
        ? gmail({ fetch: provider.gmailFetch })
        : slackMessages({ fetch: provider.fetch }),
    ],
  };
  app = await createCapvine(options);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await app.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  const client = createCapvineClient({
    baseURL,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", `session=${sessionId}`);
      return fetch(input, { ...init, headers });
    },
  });
  async function connect() {
    const pending = await client.connections.connect({ provider: kind });
    const callback = await provider.authorize(pending.url);
    const response = await fetch(callback, {
      headers: { cookie: `session=${sessionId}` },
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    await response.body?.cancel();
    const resource = await client.resources.register(
      kind === "google"
        ? {
            type: "gmail.message",
            connectionId: pending.connectionId,
            target: { messageId: "a42" },
          }
        : {
            type: "slack.message",
            connectionId: pending.connectionId,
            target: { channelId: "CFIXTURE", timestamp: "1700000000.000042" },
          },
    );
    const coordinator = await identity.generate();
    const issued = await client.grants.issue({
      resource: resource.id,
      action: resource.actions[0]!,
      audience: coordinator.did(),
      expiresIn: 1800,
    });
    const path = join(root, `${randomUUID()}.json`);
    await provisionWorker({
      path,
      coordinator,
      grant: await decodeGrant(Buffer.from(issued.grant, "base64")),
      url: issued.invocationURL,
      toolName: "read_message",
      expiresAt: new Date(Date.now() + 1200_000),
    });
    return {
      path,
      connectionId: pending.connectionId,
      worker: await loadWorker(path),
    };
  }
  return {
    root,
    provider,
    client,
    connect,
    restart: async () => {
      await app.close();
      app = await createCapvine(options);
    },
    failInvocationAt: (n: number) => {
      invocations = 0;
      failingInvocation = n;
    },
  };
}

const cli = (mode: string, first: string, second: string) =>
  promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL(
          "../examples/provider-validation/lifecycle-main.ts",
          import.meta.url,
        ),
      ),
      mode,
      first,
      second,
    ],
    { env: { PATH: process.env.PATH } },
  );

for (const kind of ["google", "slack"] as const) {
  test(`retained ${kind} assignment stays denied after fixture consent revocation, fresh connection and restart`, async (t) => {
    const f = await fixture(t, kind);
    const old = await f.connect();
    const directory = join(f.root, "retained");
    const baseline = await cli("capture", old.path, directory);
    assert.deepEqual(JSON.parse(baseline.stdout).checks, {
      retainedAssignment: true,
      originalReadSucceeded: true,
    });
    assert.equal(f.provider.counts.reads, 1);
    assert.equal(f.provider.counts.refreshes, 1);
    const snapshot = await readFile(join(directory, "worker.json"), "utf8");
    f.provider.revoke();
    await assert.rejects(old.worker.invoke());
    const status = async () =>
      (await f.client.connections.list()).connections.find(
        (c) => c.id === old.connectionId,
      )!.status;
    assert.equal(await status(), "reconnect_required");
    await f.restart();
    assert.equal(await status(), "reconnect_required");
    const fresh = await f.connect();
    assert.notEqual(fresh.connectionId, old.connectionId);
    await writeFile(
      old.path,
      "Original assignment replaced; retained snapshot must be used",
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cli("compare", directory, fresh.path);
      assert.deepEqual(JSON.parse(result.stdout).checks, {
        retainedAssignmentUnchanged: true,
        assignmentsUnexpired: true,
        sameServiceAndEndpoint: true,
        freshWorkerAndResource: true,
        freshReadSucceeded: true,
        retainedInvocationDenied: true,
      });
      assert.equal(await status(), "reconnect_required");
      for (const secret of [
        snapshot,
        JSON.parse(snapshot).signer,
        JSON.parse(snapshot).grant,
        old.worker.assignment.worker,
        old.connectionId,
        "a42",
        "1700000000.000042",
        ...f.provider.secrets(),
      ])
        assert.equal(
          (
            baseline.stdout +
            baseline.stderr +
            result.stdout +
            result.stderr
          ).includes(secret),
          false,
        );
      await f.restart();
    }
    assert.equal(f.provider.counts.reads, 3);
    assert.equal(
      await readFile(join(directory, "worker.json"), "utf8"),
      snapshot,
    );
  });
}

test("comparison rejects an old worker that still works and rejects provider/service outages", async (t) => {
  const f = await fixture(t);
  const old = await f.connect();
  const fresh = await f.connect();
  const directory = join(f.root, "retained");
  await captureWorker(old.path, directory);
  await assert.rejects(
    compareWorkers(directory, fresh.path),
    /still has access/,
  );
  for (const n of [1, 2]) {
    f.failInvocationAt(n);
    await assert.rejects(compareWorkers(directory, fresh.path), /HTTP 503/);
  }
  f.failInvocationAt(0);
  f.provider.revoke();
  await assert.rejects(compareWorkers(directory, fresh.path));
});

test("comparison requires the same endpoint/service, a new binding, intact private capture and live proofs", async (t) => {
  const f = await fixture(t);
  const old = await f.connect();
  const fresh = await f.connect();
  const directory = join(f.root, "retained");
  await captureWorker(old.path, directory);
  const before = f.provider.counts.reads;
  await assert.rejects(
    compareWorkers(directory, old.path),
    /new worker\/resource/,
  );
  const freshContent = await readFile(fresh.path, "utf8");
  const changed = JSON.parse(freshContent);
  changed.url = changed.url.replace("127.0.0.1", "localhost");
  await writeFile(fresh.path, JSON.stringify(changed));
  await assert.rejects(
    compareWorkers(directory, fresh.path),
    /same service and endpoint/,
  );
  await writeFile(fresh.path, freshContent);
  const other = await fixture(t);
  const unrelated = await other.connect();
  await assert.rejects(
    compareWorkers(directory, unrelated.path),
    /same service and endpoint/,
  );
  const snapshot = join(directory, "worker.json");
  const original = await readFile(snapshot, "utf8");
  await writeFile(snapshot, freshContent);
  await assert.rejects(
    compareWorkers(directory, fresh.path),
    /assignment changed/,
  );
  await writeFile(snapshot, original);
  await chmod(snapshot, 0o644);
  await assert.rejects(compareWorkers(directory, fresh.path), /private file/);
  await chmod(snapshot, 0o600);
  const receiptPath = join(directory, "receipt.json");
  const receipt = await readFile(receiptPath, "utf8");
  for (const value of [
    null,
    { ...JSON.parse(receipt), version: 2 },
    { ...JSON.parse(receipt), sha256: "invalid" },
    { ...JSON.parse(receipt), capturedAt: "invalid" },
    { ...JSON.parse(receipt), unexpected: true },
  ]) {
    await writeFile(receiptPath, JSON.stringify(value));
    await assert.rejects(
      compareWorkers(directory, fresh.path),
      /capture receipt/,
    );
  }
  await writeFile(receiptPath, receipt);
  assert.equal(f.provider.counts.reads, before);
  t.mock.method(
    Date,
    "now",
    () => Date.parse(old.worker.assignment.expiresAt) + 1,
  );
  await assert.rejects(
    compareWorkers(directory, fresh.path),
    /unexpired assignment/,
  );
  assert.equal(f.provider.counts.reads, before);
});

test("capture refuses overwrite and removes unsuccessful snapshots without logging private input", async (t) => {
  const f = await fixture(t);
  const old = await f.connect();
  const directory = join(f.root, "retained");
  await captureWorker(old.path, directory);
  const original = await readFile(join(directory, "worker.json"), "utf8");
  await assert.rejects(captureWorker(old.path, directory), /EEXIST/);
  assert.equal(
    await readFile(join(directory, "worker.json"), "utf8"),
    original,
  );
  f.provider.revoke();
  const failed = join(f.root, "failed");
  await assert.rejects(captureWorker(old.path, failed));
  await assert.rejects(readFile(join(failed, "worker.json")), /ENOENT/);
  await assert.rejects(
    cli("compare", directory, old.path),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Worker lifecycle check did not pass/);
      assert.equal(error.message.includes(original), false);
      return true;
    },
  );
});
