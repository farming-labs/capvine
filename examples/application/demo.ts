import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCapvine } from "../../src/setup.ts";
import { createCapvineClient } from "../../src/owner-client.ts";
import { toNodeHandler } from "../../src/node.ts";
import { gmail } from "../../src/plugins.ts";
import { oidc } from "../../src/providers.ts";
import { startProviderFixture } from "../accounts/provider-fixture.ts";
import { Peer } from "../network/ipc.ts";

export async function runApplicationExample() {
  const directory = await mkdtemp(join(tmpdir(), "capvine-app-demo-"));
  const sessionId = randomBytes(32).toString("base64url");
  let listener: RequestListener = (_request, response) => {
    response.writeHead(503);
    response.end();
  };
  const server = createServer(
    { headersTimeout: 5000, requestTimeout: 10000 },
    (request, response) => listener(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing example listener");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const provider = await startProviderFixture({
    redirectUri: `${baseURL}/api/capvine/callback`,
  });
  const coordinator = new Peer(
    new URL("../network/worker.ts", import.meta.url),
  );
  const worker = new Peer(new URL("../network/worker.ts", import.meta.url));
  let app: Awaited<ReturnType<typeof open>> | undefined;
  const { redirectUri: _, ...providerOptions } = provider.providerOptions();
  function open() {
    return createCapvine({
      baseURL,
      ownerId: "example-owner",
      storage: { directory: join(directory, "state") },
      authenticate(request) {
        return request.headers.get("cookie") === `example_session=${sessionId}`
          ? { ownerId: "example-owner", sessionId }
          : null;
      },
      providers: [oidc(providerOptions)],
      plugins: [gmail({ fetch: provider.gmailFetch })],
    });
  }
  const owner = createCapvineClient({
    baseURL,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", `example_session=${sessionId}`);
      return fetch(input, { ...init, headers });
    },
  });
  try {
    app = await open();
    listener = toNodeHandler(app, { baseURL });
    const unauthorized = await fetch(
      `${baseURL}/api/capvine/connections/list`,
      {
        method: "POST",
        headers: {
          origin: baseURL,
          "x-capvine-request": "1",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(unauthorized.status, 401);
    await unauthorized.body?.cancel();
    const pending = await owner.connections.connect({
      provider: "google",
      returnTo: "/connected",
    });
    const callback = await provider.authorize(pending.url);
    const connected = await fetch(callback, {
      redirect: "manual",
      headers: { cookie: `example_session=${sessionId}` },
    });
    assert.equal(connected.status, 303);
    await connected.body?.cancel();
    const accounts = await owner.connections.list();
    assert.equal(accounts.connections[0]?.status, "connected");
    const receipt = await owner.resources.register({
      type: "gmail.message",
      connectionId: pending.connectionId,
      target: { messageId: "a42" },
    });
    const other = await owner.resources.register({
      type: "gmail.message",
      connectionId: pending.connectionId,
      target: { messageId: "b43" },
    });
    const coordinatorInfo = await coordinator.request<{
      did: string;
      pid: number;
    }>("info");
    const workerInfo = await worker.request<{
      did: string;
      pid: number;
      environmentKeys: string[];
    }>("info");
    assert.equal(
      new Set([process.pid, coordinatorInfo.pid, workerInfo.pid]).size,
      3,
    );
    const root = await owner.grants.issue({
      resource: receipt.id,
      action: "gmail/message.read",
      audience: coordinatorInfo.did,
      expiresIn: 300,
    });
    for (const peer of [coordinator, worker])
      await peer.request("connect", {
        url: root.invocationURL,
        service: root.service,
      });
    const child = await coordinator.request<{ grant: string }>("delegate", {
      grant: root.grant,
      audience: workerInfo.did,
    });
    const read = () =>
      worker.request<{ status: string; value?: { id: string } }>("read", {
        grant: child.grant,
      });
    const first = await read();
    assert.equal(first.status, "allowed");
    assert.equal(first.value?.id, "a42");
    const count = provider.counts.reads;
    assert.deepEqual(
      await worker.request("attempt", {
        grant: child.grant,
        resource: other.id,
      }),
      { status: "denied" },
    );
    assert.equal(provider.counts.reads, count);
    for (const secret of [sessionId, ...provider.secrets()])
      assert.equal(
        JSON.stringify({ root, child, accounts }).includes(secret),
        false,
      );
    await app.close();
    app = await open();
    listener = toNodeHandler(app, { baseURL });
    assert.equal((await read()).value?.id, "a42");
    assert.equal(provider.counts.exchanges, 1);
    await owner.grants.revoke({ id: root.id });
    assert.equal((await read()).status, "denied");
    await app.close();
    app = await open();
    listener = toNodeHandler(app, { baseURL });
    assert.equal((await read()).status, "denied");
    return {
      connected: true,
      registeredWhileRunning: true,
      separateProcessDelegation: true,
      selectedMessageRead: true,
      crossResourceDenied: true,
      restartWithoutConsent: true,
      revokedAfterRestart: true,
      providerCredentialsWithheld: true,
    };
  } finally {
    await Promise.all([coordinator.close(), worker.close()]);
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runApplicationExample(), null, 2));
  console.log(
    "Local OAuth fixture and separate worker processes; no real Google account is connected. The fixture session is not a production login system.",
  );
}
