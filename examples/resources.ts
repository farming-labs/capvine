import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@ucanto/principal";
import {
  createClient,
  encodeGrant,
  identity,
  PermissionDenied,
  type Grant,
} from "../src/index.ts";
import { createHttpTransport } from "../src/http.ts";
import { createAdministrationClient } from "../src/administration.ts";
import { initializeService } from "../src/service.ts";
import { writePrivateFile } from "../src/identity-file.ts";
import { startPostgresFixture } from "./support/postgres.ts";

const run = promisify(execFile);
const database = await startPostgresFixture();
const temporary = await mkdtemp(join(tmpdir(), "capvine-resources-"));
let stop: (() => Promise<void>) | undefined;
try {
  const directory = join(temporary, "state");
  const root = join(temporary, "files");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "report.txt"), "Protected report", {
    mode: 0o600,
  });
  await initializeService(directory, "example-owner");
  const configPath = join(temporary, "server.json");
  await writePrivateFile(
    configPath,
    JSON.stringify({
      directory,
      owner: "example-owner",
      adapters: [
        {
          type: "filesystem",
          connectionId: "files",
          root,
          files: [{ id: "urn:capvine:resource:report", path: "report.txt" }],
        },
        {
          type: "postgres",
          connectionId: "database",
          databaseId: "fixture-database",
          connectionEnv: "CAPVINE_EXAMPLE_DATABASE_URL",
          records: [
            {
              id: "urn:capvine:resource:record",
              schema: "app",
              table: "records",
              key: { column: "id", value: "one" },
              tenant: { column: "tenant", value: "team-a" },
              columns: ["id", "title"],
            },
          ],
        },
      ],
    }),
  );
  const url = new URL("postgresql://fixture_reader@localhost/postgres");
  url.searchParams.set("host", database.connection.host);
  async function start() {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "serve",
        configPath,
      ],
      {
        env: { PATH: process.env.PATH, CAPVINE_EXAMPLE_DATABASE_URL: url.href },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    stop = async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    };
    const lines = createInterface({ input: child.stdout });
    try {
      const [line] = await Promise.race([
        once(lines, "line", { signal: AbortSignal.timeout(15_000) }),
        exited.then(() => {
          throw new Error("Resource server exited before readiness");
        }),
      ]);
      return JSON.parse(line) as {
        service: `did:key:${string}`;
        url: string;
        administrationUrl: string;
      };
    } finally {
      lines.close();
    }
  }
  let server = await start();
  const admin = () =>
    createAdministrationClient({ url: server.administrationUrl, token: token });
  const token = (await readFile(join(directory, "admin.token"), "utf8")).trim();
  await admin().createTask("example-job");
  const coordinator = await identity.generate();
  const worker = await identity.generate();
  const parents: Grant[] = [];
  for (const [resource, action] of [
    ["urn:capvine:resource:report", "fs/read"],
    ["urn:capvine:resource:record", "pg/record.read"],
  ] as const)
    parents.push(
      await admin().issue({
        audience: coordinator,
        taskId: "example-job",
        resource,
        action,
        expiresAt: new Date(Date.now() + 300_000),
      }),
    );
  const client = (signer = coordinator) =>
    createClient({
      signer,
      service: ed25519.Verifier.parse(server.service),
      transport: createHttpTransport({ url: server.url }),
    });
  const grants = await Promise.all(
    parents.map((grant) =>
      client().delegate({
        grant,
        audience: worker,
        expiresAt: new Date(Date.now() + 120_000),
      }),
    ),
  );
  const workerConfig = join(temporary, "worker.json");
  await writePrivateFile(
    workerConfig,
    JSON.stringify({
      signer: identity.format(worker),
      service: server.service,
      url: server.url,
      grants: await Promise.all(
        grants.map(async (grant) =>
          Buffer.from(await encodeGrant(grant)).toString("base64"),
        ),
      ),
    }),
  );
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./resource-worker.ts", import.meta.url)),
      workerConfig,
    ],
    { env: { PATH: process.env.PATH } },
  );
  assert.deepEqual(JSON.parse(stdout), [
    "Protected report",
    { id: "one", title: "Allowed record" },
  ]);
  await admin().revoke(parents[0]!.cid.toString());
  await stop!();
  server = await start();
  await assert.rejects(client(worker).invoke(grants[0]!), PermissionDenied);
  assert.deepEqual(await client(worker).invoke(grants[1]!), {
    id: "one",
    title: "Allowed record",
  });
  await admin().endTask("example-job");
  await stop!();
  server = await start();
  await assert.rejects(client(worker).invoke(grants[1]!), PermissionDenied);
  console.log(
    "Separate client read a file and a PostgreSQL record; independent grants, revocation, task end, and two authority restarts passed.",
  );
} finally {
  await stop?.();
  await database.stop();
  await rm(temporary, { recursive: true, force: true });
}
