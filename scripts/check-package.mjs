import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "capvine-package-"));
try {
  const { stdout } = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
    { cwd: root },
  );
  const [packed] = JSON.parse(stdout);
  assert.ok(packed.files.length > 0);
  assert.ok(
    packed.files.every(
      ({ path }) =>
        path.startsWith("dist/") ||
        ["package.json", "README.md", "LICENSE"].includes(path),
    ),
  );
  assert.ok(
    packed.files.every(({ path }) => !/\.(key|db|token|pem)$/.test(path)),
  );
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--package-lock=false",
      join(temporary, packed.filename),
    ],
    { cwd: consumer },
  );
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const entries = Object.keys(manifest.exports).map(
    (entry) => `${manifest.name}${entry === "." ? "" : entry.slice(1)}`,
  );
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `for (const entry of ${JSON.stringify(entries)}) await import(entry);`,
    ],
    { cwd: consumer },
  );
  await writeFile(
    join(consumer, "index.ts"),
    entries
      .map(
        (entry, index) =>
          `import * as entry${index} from ${JSON.stringify(entry)};\nvoid entry${index};`,
      )
      .join("\n"),
  );
  await run(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "index.ts",
    ],
    { cwd: consumer },
  );
  const { stdout: initialized } = await run(
    process.execPath,
    [
      join(consumer, "node_modules/@farming-labs/capvine/dist/cli.js"),
      "init",
      join(temporary, "state"),
      "package-check-owner",
    ],
    { cwd: consumer },
  );
  assert.match(JSON.parse(initialized).service, /^did:key:/);
  console.log(
    `Packed artifact verified: ${entries.length} runtime/type entry points and installed CLI; no source fixtures or state files included.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
