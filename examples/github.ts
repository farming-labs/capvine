import assert from "node:assert/strict";
import { createGitHubConnector } from "../src/github.ts";
import {
  createAuthority,
  createClient,
  identity,
  MemoryStore,
  PermissionDenied,
} from "../src/index.ts";

const connector = createGitHubConnector({ connectionId: "public-github" });
const resource = await connector.resolveIssue({
  id: "urn:capvine:resource:public-issue",
  ownerId: "example-owner",
  owner: "farming-labs",
  repository: "capvine",
  number: 3,
});
const store = new MemoryStore();
store.addResource(resource);
store.addTask({ id: "public-read", ownerId: resource.ownerId, active: true });
const authority = createAuthority({
  signer: await identity.generate(),
  store,
  authorizeGrant: ({ actor, resource }) => actor === resource.ownerId,
});
authority.registerOperation(connector.operation);
const worker = await identity.generate();
const grant = await authority.issue({
  actor: resource.ownerId,
  audience: worker,
  taskId: "public-read",
  resource: resource.id,
  action: connector.operation.action,
  expiresAt: new Date(Date.now() + 60_000),
});
const client = createClient({
  signer: worker,
  service: authority.principal,
  transport: authority.execute,
});
const result = await client.invoke(grant);
assert.ok(
  result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    result.id === resource.target.issueId,
);
store.revoke(grant.cid.toString());
await assert.rejects(client.invoke(grant), PermissionDenied);
console.log(
  "Public GitHub issue read matched its pinned repository and issue IDs; revocation denied the next request.",
);
