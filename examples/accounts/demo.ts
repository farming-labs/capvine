import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openAccountManager, type AccountManager } from "../../src/accounts.ts";
import { createGmailAdapter } from "../../src/gmail.ts";
import { createAdministrationClient } from "../../src/administration.ts";
import { startResourceServer } from "../../src/adapter.ts";
import { initializeService } from "../../src/service.ts";
import { writePrivateFile, readPrivateFile } from "../../src/identity-file.ts";
import {
  createClient,
  encodeGrant,
  identity,
  PermissionDenied,
} from "../../src/index.ts";
import { createHttpTransport } from "../../src/http.ts";
import { startProviderFixture } from "./provider-fixture.ts";

const temporary = await mkdtemp(join(tmpdir(), "capvine-direct-accounts-"));
const provider = await startProviderFixture();
let accounts: AccountManager | undefined;
let server: Awaited<ReturnType<typeof startResourceServer>> | undefined;
try {
  const keyPath = join(temporary, "credential.key");
  await writePrivateFile(keyPath, randomBytes(32).toString("base64url"));
  const openAccounts = async () =>
    openAccountManager({
      directory: join(temporary, "credentials"),
      key: Buffer.from(await readPrivateFile(keyPath), "base64url"),
      providers: [provider.provider()],
    });
  accounts = await openAccounts();
  const sessionId = randomBytes(32).toString("base64url");
  const connection = await accounts.begin({
    ownerId: "example-owner",
    sessionId,
    connectionId: "mail",
    provider: "google",
  });
  const callback = await provider.authorize(connection.url);
  const connected = await accounts.complete({
    ownerId: "example-owner",
    sessionId,
    callback,
  });
  assert.equal(connected.subject, "fixture-subject");
  console.log(
    "Direct OAuth code exchange completed against the local provider fixture; credentials were saved encrypted.",
  );
  const directory = join(temporary, "authority");
  await initializeService(directory, "example-owner");
  const token = await readPrivateFile(join(directory, "admin.token"));
  const start = () =>
    startResourceServer({
      directory,
      owner: "example-owner",
      adapters: [
        createGmailAdapter({
          accounts: accounts!,
          ownerId: "example-owner",
          fetch: provider.gmailFetch,
          messages: [
            {
              id: "urn:capvine:resource:message",
              connectionId: "mail",
              subject: "fixture-subject",
              messageId: "a42",
            },
          ],
        }),
      ],
    });
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
  const workerPath = join(temporary, "worker.json");
  await writePrivateFile(
    workerPath,
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
      workerPath,
    ],
    { env: { PATH: process.env.PATH }, timeout: 30_000 },
  );
  assert.deepEqual(JSON.parse(stdout), [
    { id: "a42", subject: "Quarterly report", snippet: "The report is ready." },
  ]);
  assert.equal(provider.counts.refreshes, 1);
  console.log(
    "Separate worker read the assigned message; the server refreshed its access token without a new consent step.",
  );
  const encrypted = await readFile(
    join(temporary, "credentials", "accounts.db"),
  );
  const provisioning = await readFile(workerPath);
  for (const secret of provider.secrets()) {
    assert.equal(encrypted.includes(Buffer.from(secret)), false);
    assert.equal(provisioning.includes(Buffer.from(secret)), false);
  }
  await server.close();
  await accounts.close();
  accounts = await openAccounts();
  server = await start();
  const renewed = await admin().issueApproved("daily-report");
  await client().invoke(renewed);
  assert.equal(provider.counts.exchanges, 1);
  assert.equal(provider.counts.refreshes, 1);
  console.log(
    "Restart retained the account, replacement refresh token, and workflow approval; a fresh grant worked without reconnecting.",
  );
  const before = provider.counts.reads;
  provider.controls.wrongSubject = true;
  await assert.rejects(client().invoke(renewed), /500/);
  assert.equal(provider.counts.reads, before);
  provider.controls.wrongSubject = false;
  await admin().disableApproval("daily-report");
  for (const parent of [grant, renewed])
    await assert.rejects(client().invoke(parent), PermissionDenied);
  await assert.rejects(client(worker).invoke(child), PermissionDenied);
  await assert.rejects(admin().issueApproved("daily-report"), /403/);
  accounts.disconnect("example-owner", "mail");
  assert.equal(
    accounts.inspect("example-owner", "mail").status,
    "disconnected",
  );
  assert.equal(provider.counts.reads, before);
  console.log(
    "Changed account identity, disabled approvals, old roots, and child grants were rejected; the local account was disconnected.",
  );
  console.log(
    "Fixture provider only. Live Google consent and deployment isolation were not exercised.",
  );
} finally {
  await server?.close();
  await accounts?.close();
  await provider.close();
  await rm(temporary, { recursive: true, force: true });
}
