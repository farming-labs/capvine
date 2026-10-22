import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { initializeService } from "../src/service.ts";
import { createFilesystemAdapter } from "../src/filesystem.ts";
import { startResourceServer } from "../src/adapter.ts";
import {
  initializeIdentity,
  loadIdentity,
  readPrivateFile,
  writePrivateFile,
  assertPrivateDirectory,
} from "../src/identity-file.ts";
import { createAdministrationClient } from "../src/administration.ts";
import { openWorkflowManager } from "../src/workflows.ts";
import { startWorkflowConsole } from "../src/workflow-console.ts";

const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    port: { type: "string", default: "8789" },
  },
});
const port = Number(values.port);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65534)
  throw new Error("Use a console port from 1024 to 65534");
const directory = values.directory
  ? resolve(values.directory)
  : await mkdtemp(join(tmpdir(), "capvine-workflows-"));
await mkdir(directory, { mode: 0o700 }).catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  },
);
await assertPrivateDirectory(directory);
let initialize = false;
try {
  await readPrivateFile(join(directory, "console.key"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  initialize = true;
}
if (initialize) {
  await mkdir(join(directory, "data"), { mode: 0o700 });
  await writePrivateFile(
    join(directory, "data/report.txt"),
    "The example report contains 12 completed items.\n",
  );
  await initializeService(join(directory, "service"), "workflow-owner");
  await initializeIdentity(join(directory, "coordinator.key"));
  await writePrivateFile(
    join(directory, "console.key"),
    randomBytes(32).toString("base64url"),
  );
}
const service = await startResourceServer({
  directory: join(directory, "service"),
  owner: "workflow-owner",
  port: port + 1,
  adapters: [
    await createFilesystemAdapter({
      root: join(directory, "data"),
      connectionId: "reports",
      ownerId: "workflow-owner",
      files: [{ id: "urn:capvine:resource:report", path: "report.txt" }],
    }),
  ],
});
let workflows: Awaited<ReturnType<typeof openWorkflowManager>> | undefined;
let consoleApp: Awaited<ReturnType<typeof startWorkflowConsole>> | undefined;
try {
  workflows = await openWorkflowManager({
    directory: join(directory, "workers"),
    ownerId: "workflow-owner",
    coordinator: await loadIdentity(join(directory, "coordinator.key")),
    service: service.principal,
    url: service.url,
    administration: createAdministrationClient({
      url: service.administrationUrl,
      token: await readPrivateFile(join(directory, "service/admin.token")),
    }),
    workflows: [
      {
        id: "report",
        label: "Read the example report",
        resource: "urn:capvine:resource:report",
        action: "fs/read",
        toolName: "read_report",
        approvalSeconds: 3600,
        grantSeconds: 300,
        workerSeconds: 60,
      },
    ],
    workerCommand: {
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
    },
  });
  consoleApp = await startWorkflowConsole({
    workflows,
    loginKey: await readPrivateFile(join(directory, "console.key")),
    port,
  });
  console.log(
    JSON.stringify(
      {
        url: consoleApp.url,
        directory,
        consoleKeyFile: join(directory, "console.key"),
        resource: "A real local example report; no external account is used.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  await workflows?.close();
  await service.close();
  throw error;
}
let closing: Promise<void> | undefined;
const close = () => {
  closing ??= (async () => {
    await consoleApp!.close();
    await workflows!.close();
    await service.close();
  })().catch(() => {
    console.error("Workflow console shutdown failed");
    process.exitCode = 1;
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
