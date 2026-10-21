import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const run = promisify(execFile);
export async function startExecutorFixture() {
  const bin = process.env.CAPVINE_EXECUTOR_BIN ?? "executor";
  const version = await run(bin, ["--version"]);
  assert.match(version.stdout, /\bv2\.0\.0-beta\.25\b/);
  const directory = await mkdtemp(join(tmpdir(), "capvine-executor-"));
  const token = randomBytes(32).toString("hex");
  const credentialA = randomBytes(32).toString("hex");
  const credentialB = randomBytes(32).toString("hex");
  let reads = 0;
  const provider = createServer((request, response) => {
    const subject =
      request.headers.authorization === `Bearer ${credentialA}`
        ? "subject-a"
        : request.headers.authorization === `Bearer ${credentialB}`
          ? "subject-b"
          : null;
    response.setHeader("content-type", "application/json");
    if (!subject) {
      response.writeHead(401).end("{}");
      return;
    }
    if (request.url === "/userinfo") {
      response.end(JSON.stringify({ sub: subject }));
      return;
    }
    if (request.url?.startsWith("/messages/")) {
      reads++;
      const id = request.url.slice("/messages/".length).split("?")[0];
      response.end(
        JSON.stringify({
          id,
          snippet: "The report is ready.",
          payload: {
            headers: [{ name: "Subject", value: "Quarterly report" }],
          },
        }),
      );
      return;
    }
    response.writeHead(404).end("{}");
  });
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  };
  let processHandle: ChildProcess | undefined;
  let exit: Promise<void> | undefined;
  async function stop() {
    if (
      processHandle &&
      processHandle.exitCode === null &&
      processHandle.signalCode === null
    ) {
      processHandle.kill("SIGTERM");
      const timer = setTimeout(() => processHandle?.kill("SIGKILL"), 10_000);
      timer.unref();
      await exit;
      clearTimeout(timer);
    }
  }
  async function close() {
    await stop();
    if (provider.listening) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const providerOrigin = `http://127.0.0.1:${await listen(provider)}`;
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      PATH: process.env.PATH,
      EXECUTOR_HOST: origin,
      EXECUTOR_PORT: String(port),
      EXECUTOR_DATA_DIR: join(directory, "executor"),
      EXECUTOR_API_KEY: token,
      EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      EXECUTOR_NO_UPDATE_CHECK: "1",
      EXECUTOR_DISABLE_ANALYTICS: "1",
      DO_NOT_TRACK: "1",
    };
    async function start() {
      processHandle = spawn(bin, ["serve"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let failure: Error | undefined;
      exit = new Promise<void>((resolve) => {
        processHandle!.once("error", (error) => {
          failure = error;
          resolve();
        });
        processHandle!.once("exit", () => resolve());
      });
      processHandle.stdout!.resume();
      processHandle.stderr!.resume();
      for (let attempt = 0; attempt < 120; attempt++) {
        if (failure || processHandle.exitCode !== null)
          throw new Error("Executor fixture failed to start");
        try {
          const response = await fetch(origin, {
            signal: AbortSignal.timeout(1000),
          });
          await response.body?.cancel();
          if (response.ok) return;
        } catch {}
        await delay(500);
      }
      throw new Error("Executor fixture readiness timed out");
    }
    const command = async (...args: string[]) => {
      try {
        const result = await run(bin, ["apps", ...args], {
          env,
          timeout: 120_000,
          maxBuffer: 4_194_304,
        });
        return JSON.parse(result.stdout);
      } catch {
        throw new Error(`Executor fixture command failed: ${args[0]}`);
      }
    };
    const api = async (path: string, method: string, body?: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Executor fixture API returned ${response.status}`);
      }
      return response.json();
    };
    await start();
    const framework = await command("framework");
    assert.equal(framework.version, "0.0.1-beta.95");
    const source = join(directory, "app");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "capvine-mail-fixture",
        private: true,
        type: "module",
        dependencies: { apps: framework.version },
      }),
    );
    await writeFile(
      join(source, "read.ts"),
      await readFile(new URL("app/read.ts", import.meta.url), "utf8"),
    );
    await writeFile(
      join(source, "index.ts"),
      `
import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
import { never } from "apps/operations/approval";
import { readBoundMessage } from "./read.ts";
const gmail = defineProvider({ name: "Capvine test mailbox", auth: { fixture: secrets({ label: "Fixture credential", fields: object({ access_token: string() }) }) } });
const requirements = { user: { accounts: { gmail } } };
export default defineApp(requirements, { tools: router({ readMessage: query({
  input: object({ accountId: string(), subject: string(), messageId: string() }), approval: never(),
}, (ctx, input) => readBoundMessage(ctx.user.accounts.gmail, input, ctx.fetch, ${JSON.stringify({ identity: `${providerOrigin}/userinfo`, messages: `${providerOrigin}/messages/` })})) }) });
`,
    );
    const app = await command(
      "create",
      "--name",
      "Capvine mail fixture",
      "--files",
      source,
    );
    await command("deploy", "--app", app.id, "--files", source);
    const accounts = `/dashboard/api/apps/${app.id}/accounts/user/gmail`;
    const accountA = await api(`${accounts}/connections`, "POST", {
      method: "fixture",
      label: "Fixture A",
      fields: { access_token: credentialA },
    });
    return {
      url: `${origin}/mcp`,
      token,
      app: app.slug as string,
      accountId: accountA.id as string,
      readCount: () => reads,
      async substituteAccount() {
        await api(`${accounts}/connections`, "POST", {
          method: "fixture",
          label: "Fixture B",
          fields: { access_token: credentialB },
        });
      },
      async restoreAccount() {
        await api(`${accounts}/${accountA.id}`, "PUT");
      },
      async substituteCredentials() {
        await api(`${accounts}/connections`, "POST", {
          account: accountA.id,
          method: "fixture",
          fields: { access_token: credentialB },
        });
      },
      async restart() {
        await stop();
        await start();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
