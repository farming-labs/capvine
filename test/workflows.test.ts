import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initializeService } from "../src/service.ts";
import { createFilesystemAdapter } from "../src/filesystem.ts";
import { startResourceServer } from "../src/adapter.ts";
import { createAdministrationClient } from "../src/administration.ts";
import {
  openWorkflowManager,
  type WorkflowDefinition,
} from "../src/workflows.ts";
import { startWorkflowConsole } from "../src/workflow-console.ts";
import {
  initializeIdentity,
  loadIdentity,
  readPrivateFile,
  writePrivateFile,
} from "../src/identity-file.ts";
import { loadWorker, renewWorker } from "../src/worker.ts";
import { identity } from "../src/index.ts";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "capvine-workflows-test-"));
  const state = join(directory, "service");
  const managerDirectory = join(directory, "workers");
  const data = join(directory, "data");
  await mkdir(data, { mode: 0o700 });
  await writePrivateFile(
    join(data, "report.txt"),
    "A real report from the registered file.",
  );
  await writePrivateFile(join(data, "other.txt"), "A different resource.");
  await initializeService(state, "owner");
  const key = join(directory, "coordinator.key");
  await initializeIdentity(key);
  const loginKey = randomBytes(32).toString("base64url");
  const definitions: WorkflowDefinition[] = [
    {
      id: "report",
      label: "Read report <script>",
      resource: "urn:capvine:resource:report",
      action: "fs/read",
      toolName: "read_report",
      approvalSeconds: 3600,
      grantSeconds: 300,
      workerSeconds: 60,
    },
  ];
  let calls = 0;
  const start = async (port = 0) => {
    const adapter = await createFilesystemAdapter({
      root: data,
      connectionId: "files",
      ownerId: "owner",
      files: [
        { id: "urn:capvine:resource:report", path: "report.txt" },
        { id: "urn:capvine:resource:other", path: "other.txt" },
      ],
    });
    const execute = adapter.operations[0]!.execute;
    adapter.operations[0]!.execute = async (resource) => {
      calls++;
      return execute(resource);
    };
    return startResourceServer({
      directory: state,
      owner: "owner",
      port,
      adapters: [adapter],
    });
  };
  let service = await start();
  const admin = () =>
    createAdministrationClient({ url: service.administrationUrl, token });
  const token = await readPrivateFile(join(state, "admin.token"));
  const managerOptions = async () => ({
    directory: managerDirectory,
    ownerId: "owner",
    coordinator: await loadIdentity(key),
    service: service.principal,
    url: service.url,
    administration: admin(),
    workflows: definitions,
  });
  let manager = await openWorkflowManager(await managerOptions());
  let app = await startWorkflowConsole({
    workflows: manager,
    loginKey,
    port: 0,
  });
  t.after(async () => {
    await app.close();
    await manager.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  function browser() {
    let cookie = "";
    let csrf = "";
    async function send(path: string, init: RequestInit = {}) {
      const response = await fetch(app.url + path, {
        ...init,
        redirect: "manual",
        headers: { cookie, ...init.headers },
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      const html = await response.text();
      csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? csrf;
      return {
        status: response.status,
        html,
        location: response.headers.get("location"),
      };
    }
    const post = (
      path: string,
      values: Record<string, string>,
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
      csrf: () => csrf,
      async login() {
        await send("/login");
        assert.equal((await post("/login", { key: loginKey })).status, 303);
        return send("/workflows");
      },
      async act(action: string, id: string) {
        await send("/workflows");
        const result = await post("/workflows/" + action, { id });
        assert.equal(result.status, 303);
        return send(result.location!);
      },
    };
  }
  return {
    directory,
    managerDirectory,
    definitions,
    token,
    loginKey,
    browser,
    admin,
    manager: () => manager,
    url: () => app.url,
    calls: () => calls,
    coordinator: () => loadIdentity(key),
    managerOptions,
    async restart() {
      const port = Number(new URL(service.url).port);
      await app.close();
      await manager.close();
      await service.close();
      service = await start(port);
      manager = await openWorkflowManager(await managerOptions());
      app = await startWorkflowConsole({
        workflows: manager,
        loginKey,
        port: 0,
      });
    },
  };
}

test("owner approval provisions a real separate worker; automatic renewal and disable survive restart", async (t) => {
  const f = await setup(t);
  const b = f.browser();
  assert.equal((await b.send("/workflows")).location, "/login");
  const empty = await b.login();
  assert.match(empty.html, /No approvals/);
  assert.match(empty.html, /Read report &lt;script&gt;/);
  assert.equal(empty.html.includes("Read report <script>"), false);
  await b.act("approve", "report");
  const approval = (await f.manager().list()).approvals[0]!;
  await b.act("provision", approval.id);
  const worker = (await f.manager().list()).workers[0]!;
  const page = await b.send("/workflows");
  assert.match(page.html, /Connect this worker to your runtime/);
  for (const secret of [
    f.token,
    f.loginKey,
    identity.format(await f.coordinator()),
    JSON.parse(await readFile(worker.path, "utf8")).signer,
  ])
    assert.equal(page.html.includes(secret), false);
  const client = new Client({ name: "workflow-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "worker",
        worker.path,
      ],
      env: {},
      stderr: "pipe",
    }),
  );
  t.after(() => client.close());
  const direct = await loadWorker(worker.path);
  const value = await direct.invoke();
  assert.equal(value, "A real report from the registered file.");
  assert.deepEqual((await client.callTool({ name: "read_report" })).content, [
    { type: "text", text: JSON.stringify(value) },
  ]);
  await f.restart();
  await b.login();
  assert.equal((await f.manager().list()).approvals[0]!.id, approval.id);
  assert.equal(await direct.invoke(), value);
  const short = await renewWorker({
    path: worker.path,
    coordinator: await f.coordinator(),
    grant: await f.admin().issueApproved(approval.id),
    expiresAt: new Date(Date.now() + 15_000),
  });
  const deadline = Date.now() + 15_000;
  let refreshed = short;
  while (Date.now() < deadline && refreshed.grantId === short.grantId) {
    await delay(200);
    refreshed = (await loadWorker(worker.path)).assignment;
  }
  assert.notEqual(
    refreshed.grantId,
    short.grantId,
    "console timer must renew the near-expiry worker",
  );
  assert.equal(refreshed.worker, worker.assignment.worker);
  assert.equal(
    (await client.callTool({ name: "read_report" })).isError,
    undefined,
  );
  assert.equal(
    (await f.manager().list()).approvals.length,
    1,
    "renewal does not create another approval",
  );
  await b.act("disable", approval.id);
  const count = f.calls();
  await assert.rejects(direct.invoke());
  assert.equal((await client.callTool({ name: "read_report" })).isError, true);
  await assert.rejects(f.manager().renew(worker.id));
  await assert.rejects(f.manager().provision(approval.id));
  await assert.rejects(f.admin().issueApproved(approval.id));
  assert.equal(f.calls(), count);
  await f.restart();
  assert.equal((await f.manager().list()).approvals[0]!.active, false);
  await assert.rejects(direct.invoke());
});

test("workflow forms reject unauthenticated, cross-origin, replayed, substituted, and extra fields", async (t) => {
  const f = await setup(t);
  const a = f.browser();
  assert.equal(
    (await a.post("/workflows/approve", { id: "report" })).status,
    403,
  );
  const b = f.browser();
  await b.login();
  assert.equal(
    (
      await b.post(
        "/workflows/approve",
        { id: "report" },
        { origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  const csrf = b.csrf();
  assert.equal(
    (
      await b.post("/workflows/approve", {
        id: "report",
        resource: "urn:capvine:resource:other",
      })
    ).status,
    400,
  );
  assert.equal(
    (await b.post("/workflows/approve", { id: "report", csrf })).status,
    403,
  );
  assert.equal((await f.manager().list()).approvals.length, 0);
  await b.act("approve", "unknown");
  assert.equal((await f.manager().list()).approvals.length, 0);
  await b.act("approve", "report");
  const id = (await f.manager().list()).approvals[0]!.id;
  await b.send("/workflows");
  const once = b.csrf();
  assert.equal(
    (await b.post("/workflows/provision", { id })).location,
    "/workflows?notice=provision",
  );
  assert.equal(
    (await b.post("/workflows/provision", { id, csrf: once })).status,
    403,
  );
  assert.equal((await f.manager().list()).workers.length, 1);
  await assert.rejects(f.manager().renew("../../service/authority.key"));
  await assert.rejects(f.manager().provision("other-approval"));
  await assert.rejects(f.manager().provision(id.replaceAll(".", "X")));
  await b.send("/workflows");
  assert.equal(
    (await b.post("/workflows/approve", { id: "report", csrf: a.csrf() }))
      .status,
    403,
  );
  assert.equal(f.calls(), 0);
});

test("workflow manager binds state and workers to owner, authority, coordinator, and configured scope", async (t) => {
  const f = await setup(t);
  const approval = await f.manager().approve("report");
  const worker = await f.manager().provision(approval.id);
  await assert.rejects(openWorkflowManager(await f.managerOptions()), /EEXIST/);
  await f.manager().close();
  await assert.rejects(
    openWorkflowManager({ ...(await f.managerOptions()), ownerId: "other" }),
    /another binding/,
  );
  await assert.rejects(
    openWorkflowManager({
      ...(await f.managerOptions()),
      coordinator: await identity.generate(),
    }),
    /another binding/,
  );
  await assert.rejects(
    openWorkflowManager({
      ...(await f.managerOptions()),
      service: await identity.generate(),
    }),
    /another binding/,
  );
  f.definitions[0]!.resource = "urn:capvine:resource:other";
  await f.restart();
  const listing = await f.manager().list();
  assert.equal(listing.approvals[0]!.configured, false);
  await assert.rejects(f.manager().renew(worker.id));
  await assert.rejects(f.manager().provision(approval.id));
  await f.manager().disable(approval.id);
  await assert.rejects((await loadWorker(worker.path)).invoke());
  assert.equal(f.calls(), 0);
});

test("approval listing is bounded, paginated, immutable, owner-scoped, and persists", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 23; i++) await f.manager().approve("report");
  const first = await f.manager().list();
  assert.equal(first.approvals.length, 20);
  assert.ok(first.nextCursor);
  const second = await f.manager().list({ after: first.nextCursor });
  assert.equal(second.approvals.length, 3);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set(
      [...first.approvals, ...second.approvals].map((approval) => approval.id),
    ).size,
    23,
  );
  first.approvals[0]!.resource = "urn:capvine:resource:other";
  assert.equal(
    (await f.manager().list()).approvals[0]!.resource,
    "urn:capvine:resource:report",
  );
  await assert.rejects(f.admin().listApprovals({ limit: 101 }));
  await assert.rejects(f.admin().listApprovals({ after: "invalid/cursor" }));
  await f.restart();
  assert.equal((await f.manager().list()).approvals.length, 20);
  const { MemoryStore } = await import("../src/memory.ts");
  const { SqliteStore } = await import("../src/sqlite.ts");
  for (const store of [new MemoryStore(), new SqliteStore(":memory:")]) {
    store.addApproval({
      ...second.approvals[0]!,
      id: "foreign",
      ownerId: "other",
      taskId: "foreign-task",
    });
    store.addApproval({
      ...second.approvals[0]!,
      id: "owned",
      taskId: "owned-task",
    });
    assert.deepEqual(
      store.listApprovals("owner", "", 20).map((row) => row.id),
      ["owned"],
    );
    assert.throws(() => store.listApprovals("owner", "", 0));
    if (store instanceof SqliteStore) store.close();
  }
});

test("an unreadable assignment cannot renew and does not hide the owner's disable control", async (t) => {
  const f = await setup(t);
  const approval = await f.manager().approve("report");
  const worker = await f.manager().provision(approval.id);
  const original = await readFile(worker.path, "utf8");
  await writeFile(worker.path, "invalid assignment");
  const listing = await f.manager().list();
  assert.deepEqual(listing.unavailableWorkers, [worker.id]);
  assert.equal(listing.approvals[0]!.active, true);
  await assert.rejects(f.manager().renew(worker.id));
  await f.manager().renewDue();
  assert.equal((await f.manager().list()).renewalFailed, true);
  const b = f.browser();
  assert.match((await b.login()).html, /assignment could not be read/);
  await b.act("disable", approval.id);
  await writeFile(worker.path, original);
  await assert.rejects((await loadWorker(worker.path)).invoke());
  assert.equal(f.calls(), 0);
});

test("a substituted administration response cannot provision a different authorized resource", async (t) => {
  const f = await setup(t);
  const approval = await f.manager().approve("report");
  const admin = f.admin();
  await admin.createTask("other-job");
  const unrelated = await admin.issue({
    audience: await f.coordinator(),
    resource: "urn:capvine:resource:other",
    action: "fs/read",
    taskId: "other-job",
    expiresAt: new Date(Date.now() + 120_000),
  });
  await f.manager().close();
  const manager = await openWorkflowManager({
    ...(await f.managerOptions()),
    administration: { ...admin, issueApproved: async () => unrelated },
  });
  try {
    await assert.rejects(manager.provision(approval.id), /saved approval/);
    assert.equal((await manager.list()).workers.length, 0);
    assert.equal(f.calls(), 0);
  } finally {
    await manager.close();
  }
});
