import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapvine } from "../../src/setup.ts";
import { createOwnerConsole } from "../../src/owner-console.ts";
import { gmail, filesystem } from "../../src/plugins.ts";
import { oidc } from "../../src/providers.ts";
import { identity } from "../../src/index.ts";
import { toNodeHandler } from "../../src/node.ts";
import { writePrivateFile } from "../../src/identity-file.ts";
import { startProviderFixture } from "../accounts/provider-fixture.ts";

const root = await mkdtemp(join(tmpdir(), "capvine-owner-demo-"));
await mkdir(join(root, "reports"), { mode: 0o700 });
await writePrivateFile(
  join(root, "reports", "daily.txt"),
  "Daily report fixture",
);
await writePrivateFile(
  join(root, "reports", "weekly.txt"),
  "Weekly report fixture",
);
let handle = async (_request: Request): Promise<Response> =>
  new Response("Starting", { status: 503 });
const server = createServer((request, response) => {
  void toNodeHandler({ handler: handle }, { baseURL })(request, response);
});
await new Promise<void>((resolve) =>
  server.listen(Number(process.env.PORT ?? 8798), "127.0.0.1", resolve),
);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing address");
const baseURL = `http://127.0.0.1:${address.port}`;
const provider = await startProviderFixture({
  redirectUri: `${baseURL}/api/capvine/callback`,
});
const { redirectUri: _, ...providerOptions } = provider.providerOptions();
const session = randomBytes(32).toString("base64url");
const app = await createCapvine({
  baseURL,
  ownerId: "demo-owner",
  storage: { directory: join(root, "state") },
  authenticate: (request) =>
    request.headers.get("cookie") === `demo_session=${session}`
      ? { ownerId: "demo-owner", sessionId: session }
      : null,
  providers: [oidc(providerOptions)],
  plugins: [
    gmail({ fetch: provider.gmailFetch }),
    filesystem({ id: "reports", root: join(root, "reports") }),
  ],
});
const worker = await identity.generate();
const console = createOwnerConsole({
  app,
  baseURL,
  providers: [{ id: "google", label: "Demo mail" }],
  plugins: [
    {
      id: "gmail",
      label: "Demo mail messages",
      type: "gmail.message",
      provider: "google",
    },
    { id: "reports", label: "Reports", type: "fs.file" },
  ],
  recipients: [{ label: "Demo report worker", audience: worker.did() }],
});
handle = async (request) => {
  const url = new URL(request.url);
  if (
    url.origin !== baseURL ||
    request.headers.get("host") !== new URL(baseURL).host
  )
    return new Response("Invalid host", { status: 400 });
  if (url.pathname === "/" && request.method === "GET")
    return new Response(
      '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capvine demo</title><h1>Permission workspace demo</h1><p>Disposable files and a simulated mail provider. No real account is connected.</p><form action="/demo-login" method="post"><button>Open demo workspace</button></form><script src="/demo-login.js"></script></html>',
      {
        headers: {
          "content-type": "text/html",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
        },
      },
    );
  if (url.pathname === "/demo-login.js" && request.method === "GET")
    return new Response(
      'document.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); const response = await fetch("/demo-login", { method: "POST", credentials: "same-origin" }); if (response.ok) location.assign("/capvine"); });',
      {
        headers: {
          "content-type": "text/javascript",
          "cache-control": "no-store",
        },
      },
    );
  if (
    url.pathname === "/demo-login" &&
    request.method === "POST" &&
    request.headers.get("origin") === baseURL
  )
    return new Response(null, {
      status: 303,
      headers: {
        location: "/capvine",
        "set-cookie": `demo_session=${session}; HttpOnly; SameSite=Lax; Path=/`,
        "cache-control": "no-store",
      },
    });
  return (await console(request)) ?? app.handler(request);
};
process.stdout.write(`Disposable owner workspace: ${baseURL}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.close();
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
process.on("SIGINT", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
