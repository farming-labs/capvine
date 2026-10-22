import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openAccountManager } from "../../src/accounts.ts";
import { createSlackAdapter } from "../../src/slack.ts";
import { createAdministrationClient } from "../../src/administration.ts";
import { startResourceServer } from "../../src/adapter.ts";
import { initializeService } from "../../src/service.ts";
import { readPrivateFile } from "../../src/identity-file.ts";
import { provisionWorker, loadWorker, renewWorker } from "../../src/worker.ts";
import { identity } from "../../src/index.ts";
import { startSlackFixture } from "./provider-fixture.ts";

const temporary = await mkdtemp(join(tmpdir(), "capvine-slack-example-"));
const provider = await startSlackFixture();
const accountOptions = {
  directory: join(temporary, "accounts"),
  key: randomBytes(32),
  providers: [provider.provider()],
};
let accounts = await openAccountManager(accountOptions);
let server: Awaited<ReturnType<typeof startResourceServer>> | undefined;
const mcp = new Client({ name: "slack-example", version: "1.0.0" });
try {
  const sessionId = randomBytes(32).toString("base64url");
  const connection = await accounts.begin({
    ownerId: "example-owner",
    sessionId,
    connectionId: "slack",
    provider: "slack",
  });
  const connected = await accounts.complete({
    ownerId: "example-owner",
    sessionId,
    callback: await provider.authorize(connection.url),
  });
  assert.equal(connected.subject, "slack:TFIXTURE:UFIXTURE");
  const directory = join(temporary, "authority");
  await initializeService(directory, "example-owner");
  const start = (port = 0) =>
    startResourceServer({
      directory,
      owner: "example-owner",
      port,
      adapters: [
        createSlackAdapter({
          accounts,
          ownerId: "example-owner",
          fetch: provider.fetch,
          messages: [
            {
              id: "urn:capvine:resource:slack-report",
              connectionId: "slack",
              subject: connected.subject!,
              channelId: "CFIXTURE",
              timestamp: "1700000000.000042",
            },
          ],
        }),
      ],
    });
  server = await start();
  const token = await readPrivateFile(join(directory, "admin.token"));
  let admin = createAdministrationClient({
    url: server.administrationUrl,
    token,
  });
  const coordinator = await identity.generate();
  await admin.approveWorkflow({
    id: "slack-report",
    audience: coordinator,
    resource: "urn:capvine:resource:slack-report",
    action: "slack/message.read",
    expiresAt: new Date(Date.now() + 3600_000),
    maxGrantSeconds: 300,
  });
  const workers = join(temporary, "workers");
  await mkdir(workers, { mode: 0o700 });
  const path = join(workers, "report.json");
  const parent = await admin.issueApproved("slack-report");
  await provisionWorker({
    path,
    coordinator,
    grant: parent,
    url: server.url,
    toolName: "read_slack_report",
    expiresAt: new Date(Date.now() + 120_000),
  });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
        "worker",
        path,
      ],
      env: {},
      stderr: "pipe",
    }),
  );
  const direct = await loadWorker(path);
  const expected = {
    channelId: "CFIXTURE",
    timestamp: "1700000000.000042",
    text: "The fixture report is ready.",
  };
  assert.deepEqual(await direct.invoke(), expected);
  assert.deepEqual(
    (await mcp.callTool({ name: "read_slack_report" })).content,
    [{ type: "text", text: JSON.stringify(expected) }],
  );
  assert.equal(provider.counts.refreshes, 1);
  console.log(
    "Direct and separate-process MCP reads returned the exact fixture Slack message; token rotation stayed in the server.",
  );
  const assignment = await readFile(path);
  const encrypted = await readFile(
    join(accountOptions.directory, "accounts.db"),
  );
  for (const secret of provider.secrets()) {
    assert.equal(assignment.includes(Buffer.from(secret)), false);
    assert.equal(encrypted.includes(Buffer.from(secret)), false);
  }
  const reads = provider.counts.reads;
  assert.equal(
    (
      await mcp.callTool({
        name: "read_slack_report",
        arguments: { channel: "COTHER" },
      })
    ).isError,
    true,
  );
  await admin.revoke(parent.cid.toString());
  assert.equal(
    (await mcp.callTool({ name: "read_slack_report" })).isError,
    true,
  );
  assert.equal(provider.counts.reads, reads);
  const port = Number(new URL(server.url).port);
  await server.close();
  await accounts.close();
  accounts = await openAccountManager(accountOptions);
  server = await start(port);
  admin = createAdministrationClient({ url: server.administrationUrl, token });
  await renewWorker({
    path,
    coordinator,
    grant: await admin.issueApproved("slack-report"),
    expiresAt: new Date(Date.now() + 120_000),
  });
  assert.equal(
    (await mcp.callTool({ name: "read_slack_report" })).isError,
    undefined,
  );
  assert.equal(provider.counts.exchanges, 1);
  console.log(
    "Account and saved approval survived restart; the running worker used a renewed grant.",
  );
  provider.revoke();
  assert.equal(
    (await mcp.callTool({ name: "read_slack_report" })).isError,
    true,
  );
  assert.equal(
    accounts.inspect("example-owner", "slack").status,
    "reconnect_required",
  );
  await admin.disableApproval("slack-report");
  await assert.rejects(admin.issueApproved("slack-report"));
  console.log(
    "Provider revocation stopped the read and required reconnecting; workflow disable blocked further grant issuance.",
  );
  console.log(
    "Local HTTP fixture only: no real Slack account, consent, or host isolation was exercised.",
  );
} finally {
  await mcp.close();
  await server?.close();
  await accounts.close();
  await provider.close();
  await rm(temporary, { recursive: true, force: true });
}
