import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output" || !args[1]))
  throw new Error(
    "Usage: node scripts/check-package.mjs [--output <new-directory-outside-checkout>]",
  );
const output = args[1] ? resolve(args[1]) : undefined;
if (output && !relative(root, output).startsWith("../"))
  throw new Error("Review bundles must be outside the source checkout");
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
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { createCapvine, workflow } from "@farming-labs/capvine/setup";
    import { filesystem } from "@farming-labs/capvine/resources";
    import { loadWorker } from "@farming-labs/capvine/worker";
    const root = ${JSON.stringify(temporary)};
    const data = join(root, "plugin-data");
    await mkdir(data, { mode: 0o700 });
    await writeFile(join(data, "report.txt"), "Consumer report", { mode: 0o600 });
    const resource = "urn:capvine:resource:report";
    const app = await createCapvine({
      directory: join(root, "plugin-state"), ownerId: "consumer", port: 0,
      resources: [filesystem({ root: data, connectionId: "reports", files: [{ id: resource, path: "report.txt" }] })],
      workflows: [workflow({ id: "read-report", resource, action: "fs/read" })],
    });
    try {
      const approval = await app.workflows.approve("read-report");
      const job = await app.workflows.provision(approval.id);
      const worker = await loadWorker(job.path);
      assert.match(JSON.stringify(await worker.invoke()), /Consumer report/);
      await app.workflows.disable(approval.id);
      await assert.rejects(worker.invoke());
    } finally { await app.close(); }
  `,
    ],
    { cwd: consumer },
  );
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { join } from "node:path";
    import { createClient, identity, decodeGrant, PermissionDenied } from "@farming-labs/capvine";
    import { createCapvine } from "@farming-labs/capvine/setup";
    import { filesystem } from "@farming-labs/capvine/plugins";
    import { createCapvineClient } from "@farming-labs/capvine/client";
    import { createOwnerConsole } from "@farming-labs/capvine/owner-console";
    const root = ${JSON.stringify(temporary)};
    const baseURL = "http://127.0.0.1:8796";
    const options = {
      baseURL, ownerId: "consumer", storage: { directory: join(root, "application-state") },
      authenticate: request => request.headers.get("cookie") === "test=owner" ? { ownerId: "consumer", sessionId: "consumer-test-session" } : null,
      plugins: [filesystem({ id: "reports", root: join(root, "plugin-data") })],
    };
    let app = await createCapvine(options);
    const owner = createCapvineClient({ baseURL, fetch: (input, init) => {
      const request = new Request(input, init); request.headers.set("cookie", "test=owner"); return app.handler(request);
    } });
    try {
      const resource = await owner.resources.register({ type: "fs.file", target: { path: "report.txt" } });
      const signer = await identity.generate();
      const console = createOwnerConsole({ app, baseURL, providers: [], plugins: [{ id: "reports", label: "Reports", type: "fs.file" }], recipients: [{ label: "Consumer worker", audience: signer.did() }] });
      for (const path of ["/capvine", "/capvine/style.css", "/capvine/assets/owner-console-browser.js", "/capvine/assets/owner-client.js", "/capvine/assets/application-contract.js"]) {
        const response = await console(new Request(baseURL + path, { headers: { cookie: "test=owner" } }));
        assert.equal(response.status, 200); assert.ok((await response.text()).length > 100);
      }
      assert.equal((await console(new Request(baseURL + "/capvine"))).status, 401);
      const issued = await owner.grants.issue({ resource: resource.id, action: "fs/read", audience: signer.did() });
      const grant = await decodeGrant(Buffer.from(issued.grant, "base64"));
      const worker = createClient({ signer, service: identity.Verifier.parse(issued.service), transport: async bytes => {
        const response = await app.handler(new Request(issued.invocationURL, { method: "POST", headers: { "content-type": "application/vnd.ipld.car" }, body: bytes }));
        if (!response.ok) throw new PermissionDenied("Denied"); return (await response.json()).ok;
      } });
      assert.equal(await worker.invoke(grant), "Consumer report");
      await app.close(); app = await createCapvine(options);
      assert.equal(await worker.invoke(grant), "Consumer report");
      await owner.grants.revoke({ id: issued.id });
      await assert.rejects(worker.invoke(grant), PermissionDenied);
      const inspected = await owner.grants.get({ id: issued.id });
      assert.equal(inspected.revoked, true);
      assert.equal(inspected.action, "fs/read");
      assert.deepEqual((await owner.grants.list()).grants, [inspected]);
      assert.deepEqual((await owner.audit.list()).events.map(event => event.outcome), ["allowed", "allowed", "denied"]);
      const saved = await owner.workflows.approve({ resource: resource.id, action: "fs/read", audience: signer.did(), expiresIn: 600 });
      const renewed = await owner.workflows.issue({ id: saved.id });
      const proof = await decodeGrant(Buffer.from(renewed.grant, "base64"));
      assert.equal(await worker.invoke(proof), "Consumer report");
      await app.close(); app = await createCapvine(options);
      assert.equal((await owner.workflows.list()).workflows[0].id, saved.id);
      await owner.workflows.disable({ id: saved.id });
      await assert.rejects(worker.invoke(proof), PermissionDenied);
      await assert.rejects(owner.workflows.issue({ id: saved.id }));
    } finally { await app.close(); }
  `,
    ],
    { cwd: consumer },
  );
  console.log(
    `Packed artifact verified: ${entries.length} runtime/type entry points, installed CLI, plugin and application workflows; no source fixtures or state files included.`,
  );
  if (output) {
    const archive = await readFile(join(temporary, packed.filename));
    const { stdout: revision } = await run("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    const { stdout: status } = await run("git", ["status", "--porcelain"], {
      cwd: root,
    });
    const evidence = {
      format: "capvine.package-review.v1",
      revision: revision.trim(),
      cleanCheckout: status.trim().length === 0,
      generatedAt: new Date().toISOString(),
      node: process.version,
      name: manifest.name,
      version: manifest.version,
      private: manifest.private === true,
      archive: packed.filename,
      sha256: createHash("sha256").update(archive).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      checked: {
        archiveContents: true,
        freshInstallation: true,
        runtimeEntries: entries,
        consumerTypes: true,
        installedCli: true,
        pluginWorkflow: true,
        applicationWorkflow: true,
      },
      publicationApproved: false,
      limits:
        "Package checks only. Independent review, provider/host evidence, registry trust, and publication are not established by this bundle.",
    };
    await mkdir(output, { mode: 0o700 });
    await copyFile(
      join(temporary, packed.filename),
      join(output, packed.filename),
    );
    await chmod(join(output, packed.filename), 0o600);
    await writeFile(
      join(output, "package-review.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Review bundle saved; publication is not approved by these checks.",
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
