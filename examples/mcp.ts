import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAdministrationClient } from "../src/administration.ts";
import { createFilesystemAdapter } from "../src/filesystem.ts";
import { startResourceServer } from "../src/adapter.ts";
import {
  initializeIdentity,
  loadIdentity,
  readPrivateFile,
  writePrivateFile,
} from "../src/identity-file.ts";
import { initializeService } from "../src/service.ts";
import { loadWorker, provisionWorker, renewWorker } from "../src/worker.ts";

const temporary = await mkdtemp(join(tmpdir(), "capvine-mcp-example-"));
const directory = join(temporary, "state");
const data = join(temporary, "data");
const workers = join(temporary, "workers");
await mkdir(data, { mode: 0o700 });
await mkdir(workers, { mode: 0o700 });
await writePrivateFile(
  join(data, "report.txt"),
  "The approved report contains 12 completed items.",
);
await initializeService(directory, "example-owner");
const coordinatorPath = join(temporary, "coordinator.key");
await initializeIdentity(coordinatorPath);
const start = async (port = 0) =>
  startResourceServer({
    directory,
    owner: "example-owner",
    port,
    adapters: [
      await createFilesystemAdapter({
        root: data,
        connectionId: "reports",
        ownerId: "example-owner",
        files: [{ id: "urn:capvine:resource:report", path: "report.txt" }],
      }),
    ],
  });
let service = await start();
const administration = async () =>
  createAdministrationClient({
    url: service.administrationUrl,
    token: await readPrivateFile(join(directory, "admin.token")),
  });
const mcp = new Client({ name: "example-runtime", version: "1.0.0" });
try {
  let admin = await administration();
  await admin.approveWorkflow({
    id: "daily-report",
    audience: await loadIdentity(coordinatorPath),
    resource: "urn:capvine:resource:report",
    action: "fs/read",
    expiresAt: new Date(Date.now() + 3_600_000),
    maxGrantSeconds: 300,
  });
  const parent = await admin.issueApproved("daily-report");
  const path = join(workers, "report.json");
  const first = await provisionWorker({
    path,
    coordinator: await loadIdentity(coordinatorPath),
    grant: parent,
    url: service.url,
    toolName: "read_report",
    expiresAt: new Date(Date.now() + 120_000),
  });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "worker",
        path,
      ],
      env: {},
      stderr: "pipe",
    }),
  );
  assert.deepEqual(
    (await mcp.listTools()).tools.map((tool) => tool.name),
    ["read_report"],
  );
  const direct = await loadWorker(path);
  const value = await direct.invoke();
  assert.deepEqual((await mcp.callTool({ name: "read_report" })).content, [
    { type: "text", text: JSON.stringify(value) },
  ]);
  console.log("Direct and separate-process MCP reads:", value);
  assert.equal(
    (
      await mcp.callTool({
        name: "read_report",
        arguments: { resource: "other" },
      })
    ).isError,
    true,
  );
  await admin.revoke(parent.cid.toString());
  assert.equal((await mcp.callTool({ name: "read_report" })).isError, true);
  const port = Number(new URL(service.url).port);
  await service.close();
  service = await start(port);
  admin = await administration();
  const renewed = await renewWorker({
    path,
    coordinator: await loadIdentity(coordinatorPath),
    grant: await admin.issueApproved("daily-report"),
    expiresAt: new Date(Date.now() + 120_000),
  });
  assert.equal(renewed.worker, first.worker);
  assert.notEqual(renewed.grantId, first.grantId);
  assert.equal(await direct.invoke(), value);
  assert.equal(
    (await mcp.callTool({ name: "read_report" })).isError,
    undefined,
  );
  console.log(
    "Saved approval survived restart; the running worker used a renewed grant without another approval.",
  );
  await admin.disableApproval("daily-report");
  assert.equal((await mcp.callTool({ name: "read_report" })).isError, true);
  await assert.rejects(direct.invoke());
  await assert.rejects(admin.issueApproved("daily-report"));
  console.log(
    "Disabling the workflow blocked direct reads, MCP reads, and further issuance.",
  );
} finally {
  await mcp.close();
  await service.close();
  await rm(temporary, { recursive: true, force: true });
}
