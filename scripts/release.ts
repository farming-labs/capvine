import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const packageName = "@farming-labs/capvine";

interface ReleaseContext {
  cwd: string;
  repository: string | undefined;
  event: string | undefined;
  ref: string | undefined;
  sha: string | undefined;
}

interface ReleaseCandidate {
  revision: string;
  version: string;
  manifest: { exports: Record<string, unknown> };
}

export async function verifyReleaseSource({
  cwd,
  repository,
  event,
  ref,
  sha,
}: ReleaseContext): Promise<ReleaseCandidate> {
  assert.equal(repository, "farming-labs/capvine", "Unexpected repository");
  assert.equal(event, "workflow_dispatch", "Release requires manual dispatch");
  assert.ok(typeof sha === "string", "Missing release revision");
  assert.match(sha, /^[a-f0-9]{40}$/, "Invalid release revision");
  assert.ok(typeof ref === "string", "Missing release tag");
  assert.ok(
    ref.startsWith("refs/tags/v"),
    "Run the workflow from a version tag",
  );
  const version = ref.slice("refs/tags/v".length);
  assert.match(version, versionPattern, "Expected a vMAJOR.MINOR.PATCH tag");
  async function git(...args: string[]) {
    return (await run("git", args, { cwd })).stdout.trim();
  }
  assert.equal(await git("rev-parse", "HEAD"), sha, "Checkout mismatch");
  assert.equal(
    await git("rev-parse", "--verify", `${ref}^{commit}`),
    sha,
    "Tag moved or does not match the workflow revision",
  );
  await git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  assert.equal(
    await git("status", "--porcelain"),
    "",
    "Checkout must be clean",
  );
  const manifest = JSON.parse(
    await readFile(resolve(cwd, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, packageName, "Unexpected package");
  assert.equal(manifest.version, version, "Tag and package version differ");
  assert.notEqual(manifest.private, true, "Package is private");
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
    tag: "latest",
  });
  return { revision: sha, version, manifest };
}

export async function requireUnpublished(
  version: string,
  request: typeof fetch = fetch,
) {
  assert.match(version, versionPattern, "Invalid release version");
  const response = await request(
    `https://registry.npmjs.org/@farming-labs%2fcapvine/${version}`,
    { redirect: "error", signal: AbortSignal.timeout(10000) },
  );
  await response.body?.cancel();
  assert.equal(
    response.status,
    404,
    response.status === 200
      ? "Version is already published"
      : "Cannot establish that the version is unpublished",
  );
}

async function boundedFile(path: string, maximum: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    assert.equal(length, stat.size, "Artifact changed while reading");
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function verifyReleaseBundle(
  directory: string,
  candidate: ReleaseCandidate,
) {
  const report = JSON.parse(
    (
      await boundedFile(resolve(directory, "package-review.json"), 1048576)
    ).toString("utf8"),
  );
  assert.equal(report.format, "capvine.package-review.v1");
  assert.equal(report.cleanCheckout, true, "Bundle checkout was dirty");
  assert.equal(report.private, false, "Bundle package is private");
  assert.equal(report.revision, candidate.revision, "Bundle revision mismatch");
  assert.equal(report.name, packageName, "Bundle package mismatch");
  assert.equal(report.version, candidate.version, "Bundle version mismatch");
  const archive = `farming-labs-capvine-${candidate.version}.tgz`;
  assert.equal(report.archive, archive, "Unexpected archive filename");
  for (const check of [
    "archiveContents",
    "freshInstallation",
    "consumerTypes",
    "installedCli",
    "pluginWorkflow",
    "applicationWorkflow",
  ])
    assert.equal(
      report.checked?.[check],
      true,
      `Missing package check: ${check}`,
    );
  const entries = Object.keys(candidate.manifest.exports).map(
    (entry) => `${packageName}${entry === "." ? "" : entry.slice(1)}`,
  );
  assert.ok(entries.length > 0, "Package has no public entries");
  assert.deepEqual(report.checked.runtimeEntries, entries);
  const path = resolve(directory, archive);
  const bytes = await boundedFile(path, 10 * 1048576);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), report.sha256);
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    report.integrity,
  );
  return { archive: path, sha256: report.sha256, integrity: report.integrity };
}

async function main() {
  const [command, directory, ...extra] = process.argv.slice(2);
  assert.ok(
    extra.length === 0 &&
      ((command === "source" && !directory) ||
        (command === "bundle" && directory)),
    "Usage: node scripts/release.ts source | bundle <directory>",
  );
  const candidate = await verifyReleaseSource({
    cwd: process.cwd(),
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
  });
  await requireUnpublished(candidate.version);
  const result = {
    revision: candidate.revision,
    version: candidate.version,
    ...(command === "bundle"
      ? await verifyReleaseBundle(directory!, candidate)
      : {}),
  };
  if (process.env.GITHUB_OUTPUT) {
    for (const [name, value] of Object.entries(result)) {
      assert.ok(!/[\r\n]/.test(value), "Invalid workflow output");
      await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
