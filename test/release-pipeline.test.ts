import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  requireUnpublished,
  verifyReleaseBundle,
  verifyReleaseSource,
} from "../scripts/release.ts";

const run = promisify(execFile);
const manifest = {
  name: "@farming-labs/capvine",
  version: "0.0.2",
  exports: { ".": "./dist/index.js", "./setup": "./dist/setup.js" },
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/",
    tag: "latest",
  },
};

test("release source requires a clean version tag at the workflow commit on main", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "capvine-release-source-"));
  const git = async (...args: string[]) =>
    (await run("git", args, { cwd })).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "release@example.invalid");
    await git("config", "user.name", "Release fixture");
    await writeFile(join(cwd, "package.json"), JSON.stringify(manifest));
    await git("add", "package.json");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "Release fixture");
    const sha = await git("rev-parse", "HEAD");
    await git("update-ref", "refs/remotes/origin/main", sha);
    await git("-c", "tag.gpgsign=false", "tag", "v0.0.2");
    const context = {
      cwd,
      sha,
      repository: "farming-labs/capvine",
      event: "workflow_dispatch",
      ref: "refs/tags/v0.0.2",
    };
    assert.equal((await verifyReleaseSource(context)).version, "0.0.2");
    for (const changed of [
      { repository: "fixture/fork" },
      { event: "push" },
      { ref: "refs/heads/main" },
      { ref: "refs/tags/v0.0.2\narchive=bad" },
      { sha: "a".repeat(40) },
    ])
      await assert.rejects(verifyReleaseSource({ ...context, ...changed }));
    await git("-c", "tag.gpgsign=false", "tag", "v0.0.3");
    await assert.rejects(
      verifyReleaseSource({ ...context, ref: "refs/tags/v0.0.3" }),
    );
    await writeFile(join(cwd, "unreviewed.txt"), "Not committed");
    await assert.rejects(verifyReleaseSource(context));
    await git("add", "unreviewed.txt");
    await git("-c", "commit.gpgsign=false", "commit", "-m", "Unmerged fixture");
    const unmerged = await git("rev-parse", "HEAD");
    await git("-c", "tag.gpgsign=false", "tag", "-f", "v0.0.2");
    await assert.rejects(verifyReleaseSource(context));
    await assert.rejects(verifyReleaseSource({ ...context, sha: unmerged }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("release staging rejects published versions and uncertain registry responses", async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    return new Response(null, { status: 404 });
  };
  await requireUnpublished("0.0.2", request);
  assert.deepEqual(urls, [
    "https://registry.npmjs.org/@farming-labs%2fcapvine/0.0.2",
  ]);
  for (const status of [200, 301, 401, 403, 429, 500])
    await assert.rejects(
      requireUnpublished("0.0.2", async () => new Response(null, { status })),
    );
  await assert.rejects(
    requireUnpublished("0.0.2", async () => {
      throw new Error("Unavailable");
    }),
  );
  await assert.rejects(requireUnpublished("../other", request));
  assert.equal(urls.length, 1);
});

test("release artifact must retain the tested revision, checks, path and bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capvine-release-bundle-"));
  const candidate = { revision: "b".repeat(40), version: "0.0.2", manifest };
  const archive = "farming-labs-capvine-0.0.2.tgz";
  const bytes = Buffer.from("A fixture representing the exact tested archive");
  const report = {
    format: "capvine.package-review.v1",
    cleanCheckout: true,
    private: false,
    revision: candidate.revision,
    name: manifest.name,
    version: manifest.version,
    archive,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    checked: {
      archiveContents: true,
      freshInstallation: true,
      consumerTypes: true,
      installedCli: true,
      pluginWorkflow: true,
      applicationWorkflow: true,
      runtimeEntries: [manifest.name, `${manifest.name}/setup`],
    },
  };
  const save = (value: unknown) =>
    writeFile(join(directory, "package-review.json"), JSON.stringify(value));
  try {
    await save(report);
    await writeFile(join(directory, archive), bytes);
    assert.equal(
      (await verifyReleaseBundle(directory, candidate)).archive,
      join(directory, archive),
    );
    for (const changed of [
      { revision: "a".repeat(40) },
      { version: "0.0.3" },
      { private: true },
      { cleanCheckout: false },
      { archive: "../outside.tgz" },
      { sha256: "0".repeat(64) },
      { integrity: "sha512-wrong" },
      { checked: { ...report.checked, freshInstallation: false } },
      { checked: { ...report.checked, runtimeEntries: [manifest.name] } },
    ]) {
      await save({ ...report, ...changed });
      await assert.rejects(verifyReleaseBundle(directory, candidate));
    }
    await save(report);
    await writeFile(join(directory, archive), "Substituted artifact");
    await assert.rejects(verifyReleaseBundle(directory, candidate));
    await rm(join(directory, archive));
    await writeFile(join(directory, "other.tgz"), bytes);
    await symlink("other.tgz", join(directory, archive));
    await assert.rejects(verifyReleaseBundle(directory, candidate));
    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory, "package-review.json"), "utf8"),
      ),
      report,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
