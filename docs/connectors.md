# GitHub and MCP integrations

## GitHub issue reads

`createGitHubConnector` from `./github` resolves an operator-selected GitHub issue into a resource and provides `github/issue.read`. It calls only `https://api.github.com`, uses GET, refuses redirects, applies a five-second deadline per request, and bounds response bytes. It checks stable numeric repository and issue IDs before returning a fixed projection of the issue. Repository names and issue numbers are routing hints, not sufficient authorization by themselves.

```ts
const github = createGitHubConnector({
  connectionId: "organization-github",
  token: protectedReadOnlyToken,
});
const resource = await github.resolveIssue({
  id: "urn:capvine:resource:issue42",
  ownerId: "owner-id",
  owner: "example",
  repository: "project",
  number: 42,
});
// Add resource and github.operation to the protected service configuration.
```

Run `npm run example:github` to read public issue #3 in this repository without credentials. This is an optional live smoke check, not a deterministic CI test. Credentialed request handling and wrong-target rejection are tested with an injected provider transport. GitHub OAuth onboarding has not been implemented or validated by that public smoke check. The separate [direct account layer](accounts.md) implements Google/OIDC connections and a Gmail reader; the [Slack integration](slack.md) uses the same manager with its own OAuth v2 provider and message reader.

For private data, the operator supplies a GitHub App installation token or a fine-grained token restricted to selected repositories with Issues read access. Follow [GitHub's Get an issue permissions](https://docs.github.com/en/rest/issues/issues#get-an-issue). The connector does not mint, refresh, or verify the provider token's scope. Keep the token only in protected connector configuration; resource records contain its connection identifier, not the credential. Create one connector per configured connection; use separate services or a trusted connection dispatcher for multiple connections using the same operation name. Pull requests are excluded.

Renames, transfers, redirects, or replacement objects fail closed. An operator must review changed routing and establish a new resource binding; the service will not retarget existing grants. Provider content remains untrusted data, even after a permitted read. `fetch` injection is a trusted application/test hook, never a worker-controlled transport.

## MCP worker bridge

`createMcpServer` from `./mcp` uses the official TypeScript MCP SDK. A trusted launcher provisions one bridge instance with one worker's signer, expected authority, task ID, and grants. Each tool closes over one grant and accepts no arguments. It cannot select a different account, task, operation, or resource from model input.

```ts
import { createMcpServer } from "@farming-labs/capvine/mcp";
import { createHttpTransport } from "@farming-labs/capvine/http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createMcpServer({
  signer: workerIdentity,
  service: expectedAuthority,
  taskId: "job-42",
  transport: createHttpTransport({ url: authorityUrl }),
  tools: [{ name: "read_assigned_issue", grant: childGrant }],
});
await server.connect(new StdioServerTransport());
```

The launcher owns the stdio channel and provisions the identity; a model-supplied worker name is not authentication. Do not share this bridge instance across tenants or jobs. Exposing it over public HTTP requires a separate authenticated session design and is not supported by this integration. A remote caller who can use the bridge can exercise its provisioned authority.

The bridge checks the grant's audience, task, and service at setup. Every tool execution then signs a fresh request and goes through the normal authority verifier. The setup check does not replace signature, expiry, revocation, or task checks at the server. Reconnecting or resuming with an old grant does not restore revoked authority. Parent-to-child delegation uses the existing client API before provisioning a child bridge; MCP itself neither grants permission nor discovers an owner's credentials.

Each tool may provide a trusted `loadGrant` callback for renewal. Before every call, the bridge checks the newly loaded proof's recipient, resource, action, task, and service against the original binding. A loader failure or changed scope rejects the call without using an older proof. The authority still verifies signatures and lifecycle state. The [worker provisioning API](workers.md) supplies a private-file loader and the `capvine worker` stdio command.

The official MCP client tests exercise tool discovery/calls, attempted argument overrides, another worker/task/service, delegated reads, renewal substitution, and revocation after reconnect through a real HTTP authority. The unit tests use an in-memory MCP transport. `npm run example:mcp` launches the worker CLI in a separate process and reads a real registered file. It checks parent revocation, service restart, renewal in the running worker from a saved approval, and workflow disable blocking both calls and issuance. CI runs that example. The example shares an OS user and is not an OS isolation boundary. Keep keys and authority state away from other OS users and untrusted code as described in [SECURITY.md](../SECURITY.md).
