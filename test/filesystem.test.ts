import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFilesystemAdapter } from "../src/filesystem.ts";
import { startResourceServer } from "../src/adapter.ts";
import { initializeService } from "../src/service.ts";
import { createAdministrationClient } from "../src/administration.ts";
import { createClient, identity, PermissionDenied } from "../src/index.ts";
import { createHttpTransport } from "../src/http.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "capvine-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "allowed.txt"), "Allowed text", {
    mode: 0o600,
  });
  await writeFile(join(directory, "other.txt"), "Other text", { mode: 0o600 });
  const options = {
    root: directory,
    connectionId: "files",
    ownerId: "owner",
    files: [{ id: "urn:capvine:resource:file" as const, path: "allowed.txt" }],
  };
  return { directory, options };
}

test("filesystem reads stay pinned to the opened file when its path is replaced", async (t) => {
  const f = await fixture(t);
  const adapter = await createFilesystemAdapter(f.options);
  t.after(() => adapter.close());
  const resource = adapter.resources[0]!;
  const execute = adapter.operations[0]!.execute;
  assert.deepEqual(
    await Promise.all(Array.from({ length: 8 }, () => execute(resource))),
    Array(8).fill("Allowed text"),
  );
  await rename(
    join(f.directory, "allowed.txt"),
    join(f.directory, "original.txt"),
  );
  await symlink(
    join(f.directory, "other.txt"),
    join(f.directory, "allowed.txt"),
  );
  assert.equal(await execute(resource), "Allowed text");
  await assert.rejects(
    execute({ ...resource, target: { ...resource.target, path: "other.txt" } }),
    PermissionDenied,
  );
  await assert.rejects(
    execute({ ...resource, id: "urn:capvine:resource:unknown" }),
    PermissionDenied,
  );
  await assert.rejects(
    execute({ ...resource, kind: "pg.record" }),
    PermissionDenied,
  );
  await assert.rejects(createFilesystemAdapter(f.options));
  await adapter.close();
  await assert.rejects(execute(resource), PermissionDenied);
});

test("filesystem rejects traversal, links, unsupported types, writable directories, and invalid content", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, "sub"));
  await symlink(f.directory, join(f.directory, "alias"));
  await symlink(join(f.directory, "other.txt"), join(f.directory, "linked"));
  await link(join(f.directory, "other.txt"), join(f.directory, "hardlink"));
  for (const path of [
    "../other.txt",
    "/etc/passwd",
    "sub/../other.txt",
    "alias/allowed.txt",
    "linked",
    "hardlink",
    "sub",
    "missing",
    "other\\file",
    "a\0b",
  ])
    await assert.rejects(
      createFilesystemAdapter({
        ...f.options,
        files: [{ id: f.options.files[0]!.id, path }],
      }),
    );
  await chmod(join(f.directory, "sub"), 0o777);
  await writeFile(join(f.directory, "sub", "file"), "test");
  await assert.rejects(
    createFilesystemAdapter({
      ...f.options,
      files: [{ id: f.options.files[0]!.id, path: "sub/file" }],
    }),
    /directory/,
  );
  await assert.rejects(
    createFilesystemAdapter({ ...f.options, maxBytes: 4 }),
    /limit/,
  );
  const adapter = await createFilesystemAdapter(f.options);
  t.after(() => adapter.close());
  await writeFile(join(f.directory, "allowed.txt"), Buffer.from([0xff]));
  await assert.rejects(adapter.operations[0]!.execute(adapter.resources[0]!));
  await writeFile(join(f.directory, "allowed.txt"), "x".repeat(131_073));
  await assert.rejects(
    adapter.operations[0]!.execute(adapter.resources[0]!),
    /limit/,
  );
});

test("resource server reads real files through grants and refuses replacement across restart", async (t) => {
  const f = await fixture(t);
  const directory = join(f.directory, "state");
  await initializeService(directory, "owner");
  const adapter = await createFilesystemAdapter(f.options);
  const server = await startResourceServer({
    directory,
    owner: "owner",
    adapters: [adapter],
  });
  t.after(() => server.close());
  const admin = createAdministrationClient({
    url: server.administrationUrl,
    token: (await readFile(join(directory, "admin.token"), "utf8")).trim(),
  });
  await admin.createTask("job");
  const worker = await identity.generate();
  const grant = await admin.issue({
    audience: worker,
    taskId: "job",
    resource: f.options.files[0]!.id,
    action: "fs/read",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const client = createClient({
    signer: worker,
    service: server.principal,
    transport: createHttpTransport({ url: server.url }),
  });
  assert.equal(await client.invoke(grant), "Allowed text");
  await admin.revoke(grant.cid.toString());
  await assert.rejects(client.invoke(grant), PermissionDenied);
  await server.close();
  await rename(
    join(f.directory, "allowed.txt"),
    join(f.directory, "original.txt"),
  );
  await writeFile(join(f.directory, "allowed.txt"), "Replacement", {
    mode: 0o600,
  });
  const replacement = await createFilesystemAdapter(f.options);
  await assert.rejects(
    startResourceServer({ directory, owner: "owner", adapters: [replacement] }),
    /persistent binding/,
  );
  await assert.rejects(
    replacement.operations[0]!.execute(replacement.resources[0]!),
    PermissionDenied,
  );
});
