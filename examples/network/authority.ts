import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  createAuthority,
  encodeGrant,
  identity,
  type Json,
} from "../../src/index.ts";
import { createHttpHandler } from "../../src/http.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { serveIpc } from "./ipc.ts";

const database = process.env.CAPVINE_DEMO_DB;
if (!database || !process.send)
  throw new Error("Start this fixture through demo.ts");
const signer = await identity.generate();
const store = new SqliteStore(database);
const providerToken = crypto.randomUUID();
const providerReads: string[] = [];
let unauthorizedProviderCalls = 0;

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

const provider = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${providerToken}`) {
    unauthorizedProviderCalls++;
    response.writeHead(401).end();
    return;
  }
  const match = /^\/issues\/(4[2-9])$/.exec(request.url ?? "");
  if (request.method !== "GET" || !match) {
    response.writeHead(404).end();
    return;
  }
  providerReads.push(match[1]!);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      number: Number(match[1]),
      title: `Fixture issue ${match[1]}`,
      body: "A simulated provider response; no real account is connected.",
    }),
  );
});
const providerUrl = await listen(provider);
store.addTask({ id: "demo-task", ownerId: "demo-owner", active: true });
store.addTask({ id: "another-task", ownerId: "demo-owner", active: true });
for (let issue = 42; issue <= 49; issue++) {
  store.addResource({
    id: `urn:capvine:resource:issue-${issue}`,
    ownerId: "demo-owner",
    kind: "github.issue",
    target: { issue: String(issue) },
  });
}

const authority = createAuthority({
  signer,
  store,
  authorizeGrant: ({ actor, resource, task }) =>
    actor === "demo-owner" &&
    actor === resource.ownerId &&
    actor === task.ownerId,
});
authority.registerOperation({
  action: "github/comment.post",
  resourceKind: "github.issue",
  execute: async () => {
    throw new Error("An unauthorized write reached a handler");
  },
});
authority.registerOperation({
  action: "github/issue.read",
  resourceKind: "github.issue",
  execute: async (resource) => {
    const response = await fetch(
      `${providerUrl}/issues/${resource.target.issue}`,
      {
        headers: { authorization: `Bearer ${providerToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error("Provider failed");
    return (await response.json()) as Json;
  },
});
const server = createServer(
  { headersTimeout: 5_000, requestTimeout: 10_000 },
  createHttpHandler({ execute: authority.execute }),
);
const url = `${await listen(server)}/invoke`;

serveIpc(
  async ({ method, params }) => {
    switch (method) {
      case "info":
        return { url, service: signer.did(), providerUrl, pid: process.pid };
      case "issue": {
        if (
          typeof params.issue !== "number" ||
          !Number.isInteger(params.issue) ||
          params.issue < 42 ||
          params.issue > 49 ||
          typeof params.audience !== "string" ||
          !params.audience.startsWith("did:key:")
        )
          throw new Error("Invalid assignment");
        const audience = identity.Verifier.parse(
          params.audience as `did:key:${string}`,
        );
        const grant = await authority.issue({
          actor: "demo-owner",
          audience,
          taskId: "demo-task",
          resource: `urn:capvine:resource:issue-${params.issue}`,
          action: "github/issue.read",
          expiresAt: new Date(Date.now() + 600_000),
        });
        return {
          grant: Buffer.from(await encodeGrant(grant)).toString("base64"),
          grantId: grant.cid.toString(),
        };
      }
      case "revoke": {
        if (
          typeof params.grantId !== "string" ||
          !store.getGrant(params.grantId)
        )
          throw new Error("Unknown root grant");
        store.revoke(params.grantId);
        return { revoked: true };
      }
      case "end-task":
        store.endTask("demo-task");
        return { ended: true };
      case "stats":
        return {
          providerReads,
          unauthorizedProviderCalls,
          audit: store.audit().map(({ outcome }) => outcome),
        };
      default:
        throw new Error("Unknown administration command");
    }
  },
  async () => {
    server.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
    store.close();
  },
);
