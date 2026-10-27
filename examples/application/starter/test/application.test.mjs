import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCapvineClient } from "@farming-labs/capvine/client";
import { readPrivateFile } from "@farming-labs/capvine/identity-file";
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
    const newPermission = await f.command("approve", {
      resource: registered[1].id,
    });
    assert.notEqual(newPermission.job.grantId, approved.job.grantId);
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
