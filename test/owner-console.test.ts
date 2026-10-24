import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapvine } from "../src/setup.ts";
import { filesystem } from "../src/plugins.ts";
import { createOwnerConsole } from "../src/owner-console.ts";
import { identity } from "../src/index.ts";

test("the owner console authenticates every page and serves only its fixed assets with a restrictive policy", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "capvine-owner-ui-"));
  await mkdir(join(directory, "files"));
  const baseURL = "http://127.0.0.1:8894";
  const app = await createCapvine({
    baseURL,
    storage: { directory: join(directory, "state") },
    ownerId: "owner",
    plugins: [filesystem({ id: "reports", root: join(directory, "files") })],
    authenticate: (request) =>
      request.headers.get("cookie") === "fixture=owner"
        ? { ownerId: "owner", sessionId: "session" }
        : null,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    app,
    baseURL,
    providers: [],
    plugins: [
      {
        id: "reports",
        label: "Reports <script>alert(1)</script>",
        type: "fs.file",
      },
    ],
    recipients: [
      { label: "Report worker", audience: (await identity.generate()).did() },
    ],
  };
  const console = createOwnerConsole(options);
  assert.equal((await console(new Request(`${baseURL}/capvine`)))?.status, 401);
  assert.equal(
    (await console(new Request(`${baseURL}/capvine/assets/owner-client.js`)))
      ?.status,
    401,
  );
  const get = (path: string) =>
    console(
      new Request(`${baseURL}${path}`, {
        headers: { cookie: "fixture=owner" },
      }),
    );
  const page = (await get("/capvine"))!;
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.ok(
    page.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
  );
  const html = await page.text();
  assert.ok(html.includes("Review this permission"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(html.includes("Reports <script>"), false);
  assert.equal(html.includes("fixture=owner"), false);
  assert.equal((await get("/capvine/assets/accounts.js"))?.status, 404);
  assert.equal((await get("/capvine/assets/owner-client.js.map"))?.status, 404);
  assert.equal((await get("/capvine/style.css"))?.status, 200);
  assert.equal(await get("/elsewhere"), null);
  assert.throws(
    () => createOwnerConsole({ ...options, baseURL: "http://localhost:9999" }),
    /same an origin|share an origin/,
  );
  assert.throws(
    () => createOwnerConsole({ ...options, path: "/api/capvine" }),
    /path/,
  );
  assert.equal(
    (
      await app.api.resources.list({
        headers: { origin: baseURL, cookie: "fixture=owner" },
      })
    ).resources.length,
    0,
  );
});
