import assert from "node:assert/strict";
import {
  createAuthority,
  createClient,
  identity,
  MemoryStore,
  PermissionDenied,
} from "../../src/index.ts";
import { createExecutorGmailAdapter } from "../../src/executor.ts";
import { startExecutorFixture } from "./fixture.ts";

console.log(
  "Starting Executor 2.0.0-beta.25 with a temporary credentialed mailbox fixture.",
);
const executor = await startExecutorFixture();
let adapter: Awaited<ReturnType<typeof createExecutorGmailAdapter>> | undefined;
try {
  const setup = () =>
    createExecutorGmailAdapter({
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
    });
  adapter = await setup();
  const store = new MemoryStore();
  store.addResource(adapter.resources[0]!);
  store.addTask({ id: "report", ownerId: "example-owner", active: true });
  const signer = await identity.generate();
  const worker = await identity.generate();
  const authority = createAuthority({
    signer,
    store,
    authorizeGrant: ({ actor }) => actor === "example-owner",
  });
  authority.registerOperation({
    ...adapter.operations[0]!,
    execute: (resource) => adapter!.operations[0]!.execute(resource),
  });
  const grant = await authority.issue({
    actor: "example-owner",
    audience: worker,
    taskId: "report",
    resource: "urn:capvine:resource:message",
    action: "gmail/message.read",
    expiresAt: new Date(Date.now() + 300_000),
  });
  const client = createClient({
    signer: worker,
    service: authority.principal,
    transport: authority.execute,
  });
  assert.deepEqual(await client.invoke(grant), {
    id: "a42",
    subject: "Quarterly report",
    snippet: "The report is ready.",
  });
  console.log(
    "Allowed read passed through real Executor; the provider credential stayed in Executor.",
  );
  await adapter.close();
  await executor.restart();
  adapter = await setup();
  await client.invoke(grant);
  console.log("Executor restart retained the connected account.");
  const before = executor.readCount();
  await executor.substituteAccount();
  await assert.rejects(client.invoke(grant), /Executor Gmail read failed/);
  assert.equal(executor.readCount(), before);
  await executor.restoreAccount();
  await executor.substituteCredentials();
  await assert.rejects(client.invoke(grant), /Executor Gmail read failed/);
  assert.equal(executor.readCount(), before);
  console.log(
    "Account relinking and replacement credentials were rejected before message access.",
  );
  store.revoke(grant.cid.toString());
  await assert.rejects(client.invoke(grant), PermissionDenied);
  console.log(
    "Revoked grant rejected. Fixture data only; real Gmail OAuth consent was not exercised.",
  );
} finally {
  await adapter?.close();
  await executor.close();
}
