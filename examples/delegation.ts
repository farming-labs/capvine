import {
  createAuthority,
  createClient,
  identity,
  MemoryStore,
  PermissionDenied,
} from "../src/index.ts";

const service = await identity.generate();
const coordinator = await identity.generate();
const researcher = await identity.generate();
const store = new MemoryStore();

store.addResource({
  id: "urn:capvine:resource:issue42",
  ownerId: "demo-owner",
  kind: "github.issue",
  target: { connectionId: "demo-github", issueNodeId: "fixture-issue-42" },
});
store.addTask({ id: "summarize-42", ownerId: "demo-owner", active: true });

const authority = createAuthority({
  signer: service,
  store,
  authorizeGrant: ({ actor, resource, task }) =>
    actor === resource.ownerId && actor === task.ownerId,
});

authority.registerOperation({
  action: "github/issue.read",
  resourceKind: "github.issue",
  execute: async (resource) => ({
    id: resource.target.issueNodeId!,
    title: "Document the setup process",
    body: "This is fixture data. No GitHub account is connected.",
  }),
});

const parent = await authority.issue({
  actor: "demo-owner",
  audience: coordinator,
  taskId: "summarize-42",
  resource: "urn:capvine:resource:issue42",
  action: "github/issue.read",
  expiresAt: new Date(Date.now() + 30 * 60_000),
});

const a = createClient({
  signer: coordinator,
  service: authority.principal,
  transport: authority.execute,
});
const child = await a.delegate({
  grant: parent,
  audience: researcher,
  expiresAt: new Date(Date.now() + 10 * 60_000),
});

const b = createClient({
  signer: researcher,
  service: authority.principal,
  transport: authority.execute,
});
console.log("B reads the assigned issue:", await b.invoke(child));

store.revoke(parent.cid.toString());
try {
  await b.invoke(child);
  throw new Error("Revoked grant unexpectedly succeeded");
} catch (error) {
  if (!(error instanceof PermissionDenied)) throw error;
  console.log("After parent revocation:", error.message);
}
