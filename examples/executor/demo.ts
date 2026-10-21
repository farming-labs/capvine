import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createClient,
  encodeGrant,
  identity,
  PermissionDenied,
} from "../../src/index.ts";
import { createExecutorGmailAdapter } from "../../src/executor.ts";
import { createAdministrationClient } from "../../src/administration.ts";
import { startResourceServer } from "../../src/adapter.ts";
import { createHttpTransport } from "../../src/http.ts";
import { writePrivateFile } from "../../src/identity-file.ts";
import { initializeService } from "../../src/service.ts";
import { startExecutorFixture } from "./fixture.ts";

console.log(
  "Starting Executor 2.0.0-beta.25 with a temporary credentialed mailbox fixture.",
);
const executor = await startExecutorFixture();
const temporary = await mkdtemp(join(tmpdir(), "capvine-executor-approval-"));
let server: Awaited<ReturnType<typeof startResourceServer>> | undefined;
try {
  const directory = join(temporary, "state");
  await initializeService(directory, "example-owner");
  const token = (await readFile(join(directory, "admin.token"), "utf8")).trim();
  async function start() {
    return startResourceServer({
      directory,
      owner: "example-owner",
      adapters: [
        await createExecutorGmailAdapter({
          url: executor.url,
          token: executor.token,
          app: executor.app,
          connectionId: "executor-mail",
          ownerId: "example-owner",
          messages: [
            {
              id: "urn:capvine:resource:message",
              accountId: executor.accountId,
              subject: "subject-a",
              messageId: "a42",
            },
          ],
        }),
      ],
    });
  }
  server = await start();
  const admin = () =>
    createAdministrationClient({ url: server!.administrationUrl, token });
  const coordinator = await identity.generate();
  const worker = await identity.generate();
  await admin().approveWorkflow({
    id: "daily-report",
    audience: coordinator,
    resource: "urn:capvine:resource:message",
    action: "gmail/message.read",
    expiresAt: new Date(Date.now() + 86_400_000),
    maxGrantSeconds: 600,
  });
  const grant = await admin().issueApproved("daily-report");
  const client = (signer = coordinator) =>
    createClient({
      signer,
      service: server!.principal,
      transport: createHttpTransport({ url: server!.url }),
    });
  const child = await client().delegate({
    grant,
    audience: worker,
    expiresAt: new Date(Date.now() + 120_000),
  });
  const workerConfig = join(temporary, "worker.json");
  await writePrivateFile(
    workerConfig,
    JSON.stringify({
      signer: identity.format(worker),
      service: server.principal.did(),
      url: server.url,
      grants: [Buffer.from(await encodeGrant(child)).toString("base64")],
    }),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../resource-worker.ts", import.meta.url)),
      workerConfig,
    ],
    { env: { PATH: process.env.PATH }, timeout: 30_000 },
  );
  assert.deepEqual(JSON.parse(stdout), [
    {
      id: "a42",
      subject: "Quarterly report",
      snippet: "The report is ready.",
    },
  ]);
  console.log(
    "Separate worker read the approved message through Capvine and real Executor; no provider or operator credential was provisioned to it.",
  );
  await server.close();
  await executor.restart();
  server = await start();
  const renewed = await admin().issueApproved("daily-report");
  assert.notEqual(grant.cid.toString(), renewed.cid.toString());
  await client().invoke(renewed);
  await client(worker).invoke(child);
  console.log(
    "Executor retained the account; Capvine retained the approval and issued another grant without a new approval.",
  );
  const before = executor.readCount();
  await executor.substituteAccount();
  await assert.rejects(client().invoke(renewed), /500/);
  assert.equal(executor.readCount(), before);
  await executor.restoreAccount();
  await executor.substituteCredentials();
  await assert.rejects(client().invoke(renewed), /500/);
  assert.equal(executor.readCount(), before);
  console.log(
    "Account relinking and replacement credentials were rejected before message access.",
  );
  await admin().disableApproval("daily-report");
  await server.close();
  server = await start();
  for (const parent of [grant, renewed])
    await assert.rejects(client().invoke(parent), PermissionDenied);
  await assert.rejects(client(worker).invoke(child), PermissionDenied);
  await assert.rejects(admin().issueApproved("daily-report"), /403/);
  assert.equal(executor.readCount(), before);
  console.log(
    "Disabled approval stayed disabled after restart: old roots, child grants, and renewal were rejected.",
  );
  console.log(
    "Fixture data only; real Gmail OAuth consent and OS isolation were not exercised.",
  );
} finally {
  await server?.close();
  await executor.close();
  await rm(temporary, { recursive: true, force: true });
}
