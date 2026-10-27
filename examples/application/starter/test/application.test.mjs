import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCapvineClient } from "@farming-labs/capvine/client";
import {
  loadIdentity,
  readPrivateFile,
  writePrivateFile,
} from "@farming-labs/capvine/identity-file";
import { decodeGrant, PermissionDenied } from "@farming-labs/capvine";
import { provisionWorker } from "@farming-labs/capvine/worker";
import { probeResource } from "../probe.mjs";
import { assignmentPath, saveJob } from "../state.mjs";
import { initialize } from "../setup.mjs";
import { openAuth } from "../auth.mjs";

async function freeOrigin() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function launch(directory) {
  const child = fork(new URL("../server.mjs", import.meta.url), {
    env: { CAPVINE_STARTER_DATA: directory, NODE_ENV: "production" },
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("App startup timed out"));
    }, 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("App exited before readiness"));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  assert.equal(ready.ready, true);
  return {
    pid: child.pid,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      try {
        await done;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "capvine-starter-test-"));
  const directory = join(root, "app");
  const baseURL = await freeOrigin();
  const email = "owner@example.test";
  const password = randomBytes(24).toString("base64url");
  let app;
  t.after(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });
  await initialize({ directory, baseURL, email, password });
  app = await launch(directory);
  let cookie = "";
  async function post(path, body = {}, overrides = {}) {
    return fetch(baseURL + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        origin: baseURL,
        "x-starter-request": "1",
        cookie,
        ...overrides,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  }
  async function signIn() {
    const response = await post("/api/auth/sign-in/email", { email, password });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    assert.ok(
      cookies.some(
        (value) => /HttpOnly/i.test(value) && /SameSite=Strict/i.test(value),
      ),
    );
    cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    await response.body?.cancel();
  }
  const client = createCapvineClient({
    baseURL,
    fetch: (input, init) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", cookie);
      return fetch(input, { ...init, headers });
    },
  });
  async function command(name, body = {}) {
    const response = await post(`/api/starter/${name}`, body);
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  return {
    directory,
    baseURL,
    email,
    password,
    client,
    post,
    signIn,
    command,
    get cookie() {
      return cookie;
    },
    get pid() {
      return app.pid;
    },
    async restart() {
      await app.close();
      app = await launch(directory);
    },
  };
}

test(
  "published package: owner login, file selection, delegated worker, raw denial and revocation survive process restart",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const manifest = JSON.parse(
      await readFile(
        new URL(
          "../node_modules/@farming-labs/capvine/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(manifest.version, "0.0.1");
    assert.equal((await f.post("/api/starter/status")).status, 401);
    await f.signIn();
    const choices = await f.client.resources.discover({ plugin: "reports" });
    assert.deepEqual(choices.items.map((item) => item.label).sort(), [
      "daily.txt",
      "weekly.txt",
    ]);
    const registered = [];
    for (const choice of choices.items)
      registered.push(
        await f.client.resources.register({
          type: "fs.file",
          plugin: "reports",
          target: choice.target,
        }),
      );
    assert.equal((await f.command("status")).job, null);
    assert.equal((await f.post("/api/starter/read")).status, 409);
    const approved = await f.command("approve", { resource: registered[0].id });
    assert.notEqual(approved.workerPid, f.pid);
    assert.notEqual(approved.workerPid, process.pid);
    const read = await f.command("read");
    assert.equal(read.status, "allowed");
    assert.ok(JSON.stringify(read.value).includes("requests completed"));
    assert.deepEqual(await f.command("probe", { resource: registered[1].id }), {
      status: "denied",
    });
    assert.equal(
      (await f.post("/api/starter/approve", { resource: registered[1].id }))
        .status,
      409,
    );
    const assignmentPath = join(
      f.directory,
      "workers",
      approved.job.id,
      "assignment.json",
    );
    const originalAssignment = await readPrivateFile(assignmentPath, 65_536);
    assert.equal(originalAssignment.includes(f.cookie), false);
    assert.equal(
      originalAssignment.includes(
        await readPrivateFile(join(f.directory, "auth-secret")),
      ),
      false,
    );
    assert.equal(
      originalAssignment.includes(
        await readPrivateFile(join(f.directory, "coordinator.key")),
      ),
      false,
    );
    await f.restart();
    const resumed = await f.command("status");
    assert.equal(resumed.worker, approved.worker);
    assert.notEqual(resumed.workerPid, approved.workerPid);
    assert.equal((await f.command("read")).status, "allowed");
    await f.command("revoke");
    assert.deepEqual(await f.command("read"), { status: "denied" });
    await f.restart();
    assert.ok(
      approved.job.expiresAt > Date.now() / 1000,
      "The original proof must remain unexpired to establish persisted revocation",
    );
    assert.equal(
      await readPrivateFile(assignmentPath, 65_536),
      originalAssignment,
    );
    assert.deepEqual(await f.command("read"), { status: "denied" });
    assert.equal(
      (await f.post("/api/starter/approve", { resource: registered[1].id }))
        .status,
      409,
    );
    await f.command("disable");
    const newPermission = await f.command("approve", {
      resource: registered[1].id,
    });
    assert.notEqual(newPermission.job.grantId, approved.job.grantId);
    assert.equal((await f.command("read")).status, "allowed");
  },
);

async function registerReports(f) {
  await f.signIn();
  const { items } = await f.client.resources.discover({ plugin: "reports" });
  return Promise.all(
    items.map((item) =>
      f.client.resources.register({
        type: "fs.file",
        plugin: "reports",
        target: item.target,
      }),
    ),
  );
}

test(
  "saved approval renews the same running worker; ending it blocks retained proofs and future issuance after restart",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const [file, other] = await registerReports(f);
    const original = await f.command("approve", { resource: file.id });
    assert.equal((await f.client.workflows.list()).workflows.length, 1);
    assert.ok(original.job.expiresAt <= original.job.workflowExpiresAt);
    assert.ok(original.job.expiresAt <= Date.now() / 1000 + 300);
    const path = assignmentPath(f.directory, original.job);
    const oldPath = join(f.directory, "retained-assignment.json");
    const oldBytes = await readPrivateFile(path, 65_536);
    await writePrivateFile(oldPath, oldBytes);
    await probeResource(oldPath, file.id);
    assert.equal(
      (await f.post("/api/starter/renew", { resource: other.id })).status,
      400,
    );
    assert.equal(await readPrivateFile(path, 65_536), oldBytes);
    const renewed = await f.command("renew");
    assert.equal(renewed.worker, original.worker);
    assert.equal(renewed.workerPid, original.workerPid);
    assert.equal(renewed.job.workflowId, original.job.workflowId);
    assert.equal(renewed.job.workflowExpiresAt, original.job.workflowExpiresAt);
    assert.equal(renewed.job.resource, file.id);
    assert.notEqual(renewed.job.grantId, original.job.grantId);
    assert.equal((await f.client.workflows.list()).workflows.length, 1);
    const nextBytes = await readPrivateFile(path, 65_536);
    assert.equal(JSON.parse(nextBytes).signer, JSON.parse(oldBytes).signer);
    assert.notEqual(JSON.parse(nextBytes).grant, JSON.parse(oldBytes).grant);
    assert.equal((await f.command("read")).status, "allowed");
    await assert.rejects(probeResource(oldPath, file.id), PermissionDenied);
    assert.deepEqual(await f.command("probe", { resource: other.id }), {
      status: "denied",
    });
    await f.command("revoke");
    assert.deepEqual(await f.command("read"), { status: "denied" });
    await f.restart();
    assert.deepEqual(await f.command("read"), { status: "denied" });
    const resumed = await f.command("renew");
    assert.equal(resumed.worker, original.worker);
    assert.equal((await f.command("read")).status, "allowed");
    const latestBytes = await readPrivateFile(path, 65_536);
    const ended = await f.command("disable");
    assert.equal(ended.job.disabled, true);
    assert.equal(ended.workerPid, null);
    assert.throws(() => process.kill(resumed.workerPid, 0), { code: "ESRCH" });
    assert.ok(resumed.job.expiresAt > Date.now() / 1000);
    await assert.rejects(probeResource(path, file.id), PermissionDenied);
    await assert.rejects(
      f.client.workflows.issue({ id: original.job.workflowId }),
      { status: 403 },
    );
    assert.equal((await f.post("/api/starter/renew")).status, 409);
    assert.equal((await f.post("/api/starter/read")).status, 409);
    await f.restart();
    assert.equal((await f.command("status")).workerPid, null);
    assert.equal(await readPrivateFile(path, 65_536), latestBytes);
    await assert.rejects(probeResource(path, file.id), PermissionDenied);
    await assert.rejects(
      f.client.workflows.issue({ id: original.job.workflowId }),
      { status: 403 },
    );
    assert.equal((await f.post("/api/starter/renew")).status, 409);
    const replacement = await f.command("approve", { resource: other.id });
    assert.notEqual(replacement.worker, original.worker);
    assert.notEqual(replacement.job.workflowId, original.job.workflowId);
    assert.equal((await f.command("read")).status, "allowed");
  },
);

test(
  "failed renewal persistence revokes the installed proof; a damaged assignment does not prevent owner shutdown",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const [file] = await registerReports(f);
    const original = await f.command("approve", { resource: file.id });
    const path = assignmentPath(f.directory, original.job);
    const oldPath = join(f.directory, "retained-assignment.json");
    const oldBytes = await readPrivateFile(path, 65_536);
    await writePrivateFile(oldPath, oldBytes);
    const metadataPath = join(f.directory, "job.json");
    const metadata = await readPrivateFile(metadataPath);
    await unlink(metadataPath);
    await mkdir(metadataPath, { mode: 0o700 });
    assert.equal((await f.post("/api/starter/renew")).status, 503);
    const failedBytes = await readPrivateFile(path, 65_536);
    assert.notEqual(JSON.parse(failedBytes).grant, JSON.parse(oldBytes).grant);
    await assert.rejects(probeResource(path, file.id), PermissionDenied);
    await assert.rejects(probeResource(oldPath, file.id), PermissionDenied);
    assert.deepEqual(await f.command("read"), { status: "denied" });
    await rm(metadataPath, { recursive: true });
    await writePrivateFile(metadataPath, metadata);
    await f.restart();
    assert.deepEqual(await f.command("read"), { status: "denied" });
    const recovered = await f.command("renew");
    assert.equal(recovered.worker, original.worker);
    assert.equal((await f.command("read")).status, "allowed");
    await unlink(path);
    await f.restart();
    assert.equal((await f.command("status")).workerPid, null);
    assert.equal((await f.post("/api/starter/read")).status, 409);
    assert.equal((await f.post("/api/starter/renew")).status, 409);
    await f.command("disable");
    await assert.rejects(
      f.client.workflows.issue({ id: original.job.workflowId }),
      { status: 403 },
    );
  },
);

test(
  "legacy one-time assignments resume without silently acquiring renewable approval",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const [file] = await registerReports(f);
    const coordinator = await loadIdentity(
      join(f.directory, "coordinator.key"),
    );
    const grant = await f.client.grants.issue({
      resource: file.id,
      action: "fs/read",
      audience: coordinator.did(),
      expiresIn: 300,
    });
    const job = {
      id: crypto.randomUUID(),
      grantId: grant.id,
      resource: file.id,
      expiresAt: grant.expiresAt,
      revoked: false,
    };
    const path = assignmentPath(f.directory, job);
    await mkdir(join(f.directory, "workers", job.id), { mode: 0o700 });
    await provisionWorker({
      path,
      coordinator,
      grant: await decodeGrant(Buffer.from(grant.grant, "base64")),
      url: grant.invocationURL,
      toolName: "read_report",
      expiresAt: new Date(grant.expiresAt * 1000),
    });
    await saveJob(f.directory, job);
    await f.restart();
    assert.equal((await f.command("read")).status, "allowed");
    assert.equal((await f.post("/api/starter/renew")).status, 409);
    assert.equal((await f.client.workflows.list()).workflows.length, 0);
    await f.command("disable");
    await assert.rejects(probeResource(path, file.id), PermissionDenied);
    const replacement = await f.command("approve", { resource: file.id });
    assert.ok(replacement.job.workflowId);
    assert.equal((await f.command("read")).status, "allowed");
  },
);

test(
  "real sessions reject wrong passwords, cross-origin requests, non-owners and logged-out cookies",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const wrong = await f.post("/api/auth/sign-in/email", {
      email: f.email,
      password: "incorrect-password",
    });
    assert.equal(wrong.status, 401);
    assert.equal(
      (
        await f.post("/api/auth/sign-up/email", {
          email: "other@example.test",
          password: f.password,
          name: "Other",
        })
      ).status,
      404,
    );
    await f.signIn();
    for (const route of ["renew", "disable"]) {
      assert.equal(
        (await f.post(`/api/starter/${route}`, {}, { cookie: "" })).status,
        401,
      );
      assert.equal(
        (
          await f.post(
            `/api/starter/${route}`,
            {},
            { origin: "https://untrusted.example" },
          )
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await f.post(
          "/api/starter/status",
          {},
          { origin: "https://untrusted.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.post("/api/starter/status", {}, { "x-starter-request": "" }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.post(
          "/api/auth/sign-out",
          {},
          { origin: "https://untrusted.example" },
        )
      ).status,
      403,
    );
    const badHost = await new Promise((resolve, reject) => {
      const request = httpRequest(
        f.baseURL,
        { headers: { host: "untrusted.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(badHost, 400);
    assert.equal((await fetch(`${f.baseURL}/.data/auth-secret`)).status, 404);
    assert.equal(
      (await f.post("/api/starter/status", { padding: "x".repeat(32_768) }))
        .status,
      413,
    );
    const result = await f.post("/api/auth/sign-out");
    assert.equal(result.status, 200);
    assert.equal((await f.post("/api/starter/status")).status, 401);
    await assert.rejects(f.client.resources.list(), { status: 401 });

    const otherAuth = openAuth({
      directory: f.directory,
      baseURL: f.baseURL,
      secret: await readPrivateFile(join(f.directory, "auth-secret")),
      bootstrap: true,
    });
    try {
      await otherAuth.auth.api.signUpEmail({
        body: {
          email: "other@example.test",
          password: f.password,
          name: "Other",
        },
      });
    } finally {
      otherAuth.close();
    }
    const otherLogin = await f.post("/api/auth/sign-in/email", {
      email: "other@example.test",
      password: f.password,
    });
    assert.equal(otherLogin.status, 200);
    const otherCookie = otherLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.equal(
      (await f.post("/api/starter/status", {}, { cookie: otherCookie })).status,
      403,
    );
    assert.equal(
      (
        await f.post(
          "/api/capvine/resources/list",
          {},
          { cookie: otherCookie, "x-capvine-request": "1" },
        )
      ).status,
      403,
    );
  },
);

test(
  "setup refuses to replace existing owner state",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      initialize({
        directory: f.directory,
        baseURL: f.baseURL,
        email: f.email,
        password: f.password,
      }),
      { code: "EEXIST" },
    );
    await f.signIn();
    assert.equal((await f.command("status")).job, null);
  },
);

test(
  "sign-in throttling survives restart and ignores caller-supplied client IPs",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    for (let index = 0; index < 5; index++) {
      const result = await f.post(
        "/api/auth/sign-in/email",
        { email: f.email, password: "incorrect-password" },
        { "x-starter-client-ip": `192.0.2.${index + 1}` },
      );
      assert.equal(result.status, 401);
      await result.body?.cancel();
    }
    await f.restart();
    const limited = await f.post(
      "/api/auth/sign-in/email",
      { email: f.email, password: f.password },
      { "x-starter-client-ip": "192.0.2.200" },
    );
    assert.equal(limited.status, 429);
  },
);
