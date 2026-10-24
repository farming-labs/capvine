import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCapvine } from "../src/setup.ts";
import { filesystem } from "../src/plugins.ts";
import { toNodeHandler } from "../src/node.ts";
import { identity, decodeGrant } from "../src/index.ts";
import { writePrivateFile } from "../src/identity-file.ts";
import { provisionWorker, loadWorker } from "../src/worker.ts";
import { checkDeployment } from "../examples/deployment/check.ts";

test("deployment probe exercises real HTTP denial paths and an assigned read, and fails on exposure or revoked authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "capvine-deployment-check-"));
  await mkdir(join(root, "files"), { mode: 0o700 });
  await writePrivateFile(
    join(root, "files", "report.txt"),
    "Private fixture report",
  );
  let handler = async (_request: Request): Promise<Response> =>
    new Response(null, { status: 503 });
  let baseURL = "http://127.0.0.1:0";
  const server = createServer((request, response) => {
    void toNodeHandler({ handler }, { baseURL })(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseURL = `http://127.0.0.1:${address.port}`;
  const app = await createCapvine({
    baseURL,
    storage: { directory: join(root, "state") },
    ownerId: "owner",
    authenticate: (request) =>
      request.headers.get("cookie") === "fixture=owner"
        ? { ownerId: "owner", sessionId: "session" }
        : null,
    plugins: [filesystem({ id: "reports", root: join(root, "files") })],
  });
  let exposeAdmin = false;
  handler = (request) =>
    new URL(request.url).pathname === "/__capvine_acceptance_not_found__"
      ? Promise.resolve(new Response(null, { status: 404 }))
      : exposeAdmin && new URL(request.url).pathname === "/admin"
        ? Promise.resolve(new Response("incorrectly exposed"))
        : app.handler(request);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { cookie: "fixture=owner", origin: baseURL };
  const resource = await app.api.resources.register({
    headers,
    body: { type: "fs.file", target: { path: "report.txt" } },
  });
  const coordinator = await identity.generate();
  const issued = await app.api.grants.issue({
    headers,
    body: {
      resource: resource.id,
      action: "fs/read",
      audience: coordinator.did(),
    },
  });
  const assignment = join(root, "worker.json");
  await provisionWorker({
    path: assignment,
    coordinator,
    grant: await decodeGrant(Buffer.from(issued.grant, "base64")),
    url: issued.invocationURL,
    toolName: "read_report",
    expiresAt: new Date(Date.now() + 60000),
  });
  const worker = await loadWorker(assignment);
  await assert.rejects(checkDeployment({ worker }), /HTTPS/);
  const result = await checkDeployment({ worker, allowLoopbackHttp: true });
  assert.equal(result.assignedReadSucceeded, true);
  assert.equal(result.transport, "loopback-test-only");
  assert.equal(JSON.stringify(result).includes("Private fixture"), false);
  exposeAdmin = true;
  await assert.rejects(
    checkDeployment({ worker, allowLoopbackHttp: true }),
    /Ingress boundary/,
  );
  exposeAdmin = false;
  await app.api.grants.revoke({ headers, body: { id: issued.id } });
  await assert.rejects(checkDeployment({ worker, allowLoopbackHttp: true }));
});
