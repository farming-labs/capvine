import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, identity, PermissionDenied } from "../src/index.ts";
import { createAdministrationClient } from "../src/administration.ts";
import { startConfiguredService } from "../src/configuration.ts";
import { initializeService } from "../src/service.ts";
import { readPrivateFile, writePrivateFile } from "../src/identity-file.ts";
import { createHttpTransport } from "../src/http.ts";

const temporary = await mkdtemp(join(tmpdir(), "capvine-inspect-"));
let service: Awaited<ReturnType<typeof startConfiguredService>> | undefined;
try {
  const directory = join(temporary, "state");
  const root = join(temporary, "reports");
  await mkdir(root, { mode: 0o700 });
  await writePrivateFile(join(root, "daily.txt"), "Example report");
  await initializeService(directory, "example-owner");
  const options = {
    directory,
    owner: "example-owner",
    port: 0,
    administrationPort: 0,
    adapters: [
      {
        type: "filesystem" as const,
        connectionId: "reports",
        root,
        files: [
          { id: "urn:capvine:resource:daily" as const, path: "daily.txt" },
        ],
      },
    ],
  };
  service = await startConfiguredService(options);
  const tokenFile = join(directory, "admin.token");
  const token = await readPrivateFile(tokenFile);
  const admin = () =>
    createAdministrationClient({ url: service!.administrationUrl, token });
  const coordinator = await identity.generate();
  const worker = await identity.generate();
  const client = (signer = coordinator) =>
    createClient({
      signer,
      service: service!.principal,
      transport: createHttpTransport({ url: service!.url }),
    });
  await admin().createTask("read-report");
  const parent = await admin().issue({
    audience: coordinator,
    taskId: "read-report",
    resource: "urn:capvine:resource:daily",
    action: "fs/read",
    expiresAt: new Date(Date.now() + 300_000),
  });
  const child = await client().delegate({
    grant: parent,
    audience: worker,
    expiresAt: new Date(Date.now() + 120_000),
  });
  assert.equal(await client(worker).invoke(child), "Example report");
  await admin().revoke(parent.cid.toString());
  await service.close();
  service = await startConfiguredService(options);
  await assert.rejects(client(worker).invoke(child), PermissionDenied);
  const config = join(temporary, "inspect.json");
  await writePrivateFile(
    config,
    JSON.stringify({ url: service.administrationUrl, tokenFile, limit: 25 }),
  );
  for (const kind of ["grants", "audit"]) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "inspect",
      config,
      kind,
    ]);
    const result = JSON.parse(stdout);
    if (kind === "grants") {
      assert.equal(result.grants.length, 1);
      assert.equal(result.grants[0].revoked, true);
    } else {
      assert.deepEqual(
        result.events.map((event: { outcome: string }) => event.outcome),
        ["allowed", "denied"],
      );
    }
    console.log(JSON.stringify({ [kind]: result }, null, 2));
  }
  console.log(
    "Real temporary file: delegated read allowed, parent revoked, child denied after restart. Inspection shows the recorded root and both outcomes; offline child grants are not indexed.",
  );
} finally {
  await service?.close();
  await rm(temporary, { recursive: true, force: true });
}
