import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfiguration, loadConfiguration } from "../src/configuration.ts";
import { writePrivateFile } from "../src/identity-file.ts";

const filesystem = {
  type: "filesystem",
  root: "data",
  connectionId: "files",
  files: [{ id: "urn:capvine:resource:report", path: "report.txt" }],
};
const configuration = {
  directory: "state",
  owner: "owner",
  adapters: [filesystem],
};

test("configuration rejects extra authority fields, credential values, invalid adapters, and duplicates", () => {
  const parsed = parseConfiguration(configuration, "/protected");
  assert.equal(parsed.directory, "/protected/state");
  assert.equal(parsed.port, 0);
  for (const input of [
    { ...configuration, actor: "another-owner" },
    { ...configuration, port: -1 },
    { ...configuration, adapters: [{ ...filesystem, credentials: "secret" }] },
    { ...configuration, adapters: [{ ...filesystem, type: "shell" }] },
    { ...configuration, adapters: [filesystem, filesystem] },
    {
      ...configuration,
      adapters: [
        { ...filesystem, files: [filesystem.files[0], filesystem.files[0]] },
      ],
    },
    {
      ...configuration,
      adapters: [
        {
          type: "postgres",
          connectionId: "db",
          databaseId: "id",
          connectionEnv: "postgresql://secret",
          records: [],
        },
      ],
    },
    {
      ...configuration,
      adapters: [
        {
          ...filesystem,
          files: [{ id: "https://other.example", path: "file" }],
        },
      ],
    },
  ])
    assert.throws(() => parseConfiguration(input, "/protected"));
});

test("configuration loading requires a protected bounded file and directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "capvine-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  await writePrivateFile(path, JSON.stringify(configuration));
  assert.equal((await loadConfiguration(path)).owner, "owner");
  const linked = join(directory, "linked.json");
  await symlink(path, linked);
  await assert.rejects(loadConfiguration(linked));
  await chmod(path, 0o644);
  await assert.rejects(loadConfiguration(path), /private file/);
  await chmod(path, 0o600);
  await chmod(directory, 0o755);
  await assert.rejects(loadConfiguration(path), /0700/);
  await chmod(directory, 0o700);
});
