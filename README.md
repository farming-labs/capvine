# Capvine

**Delegated, resource-bound permissions for agent tools.**

Capvine is an experimental TypeScript library from [Farming Labs](https://github.com/farming-labs). Give a worker permission to perform one operation on one resource, let it delegate that permission with a shorter lifetime, and verify every invocation before calling your existing connector.

```text
Owner policy → grant for A → narrower grant for B
                                         ↓
                             signed invocation + proofs
                                         ↓
                     Capvine verification + lifecycle checks
                                         ↓
                            your existing tool handler
```

Capvine builds on [ucanto](https://github.com/storacha/ucanto). It does not implement its own cryptography, replace your agent runtime, or authenticate directly to GitHub, Gmail, or Slack.

## Status

This repository contains the first working prototype. The package is private to prevent accidental npm publication; the source is MIT licensed. APIs may change. It has not had an independent security review.

Implemented:

- Signed owner-authorized grants and parent-to-child delegation.
- Exact resource, operation, task, and receiving-service restrictions.
- Expiration, parent/child revocation, and task termination.
- Memory and SQLite state stores, with audit outcomes.
- Serialized proof archives and a transport callback for embedding in a backend.
- An offline issue-reading example and tests that bypass the client to attack server enforcement.

Not implemented: an HTTP service, MCP adapter, live GitHub connector, OAuth, approval UI, worker isolation, write-operation replay protection, budgets, or a managed service. The GitHub example uses fixture data.

## Run the example

Requires Node.js 24 or later and npm.

```sh
git clone https://github.com/farming-labs/capvine.git
cd capvine
npm ci
npm run check
npm run example
```

The example creates a permission for Agent A, delegates it to Agent B, reads one fixture issue, revokes A's grant, and demonstrates that B's next call fails. No external account or model API key is needed.

## The developer integration

The server runs in protected application code. Your application supplies its authenticated actor, resource registry, operation handlers, secret management, and owner policy.

```ts
const authority = createAuthority({
  signer: serviceIdentity,
  store,
  authorizeGrant: ({ actor, resource, task }) =>
    actor === resource.ownerId && actor === task.ownerId,
});

authority.registerOperation({
  action: "github/issue.read",
  resourceKind: "github.issue",
  execute: (resource) => existingConnector.readIssue(resource.target),
});

const parent = await authority.issue({
  actor: authenticatedUser.id,
  audience: workerA,
  taskId: "summarize-42",
  resource: "urn:capvine:resource:issue42",
  action: "github/issue.read",
  expiresAt: new Date(Date.now() + 30 * 60_000),
});
```

`existingConnector` represents application code, not a Capvine API. The operation receives the server's immutable resource binding; the caller cannot replace it with an unchecked target. The full setup is in [examples/delegation.ts](examples/delegation.ts).

On the worker side:

```ts
const a = createClient({
  signer: workerA,
  service: authority.principal,
  transport,
});

const child = await a.delegate({
  grant: parent,
  audience: workerB,
  expiresAt: new Date(Date.now() + 10 * 60_000),
});

const b = createClient({
  signer: workerB,
  service: authority.principal,
  transport,
});

const result = await b.invoke(child);
```

`transport` sends serialized invocation bytes to `authority.execute` in your backend. The demo calls it in process to show the flow; that arrangement does not isolate arbitrary agent code from server secrets. Deploy them separately when the worker runs untrusted code.

## Persist state

Use `SqliteStore` from the `./sqlite` entry in place of `MemoryStore`. It stores resources, tasks, issued root grants, revocations, and audit outcomes. Preserve the service identity across restarts through your existing secret store. The database contains no signing keys or provider credentials.

Store administration is privileged application code:

```ts
store.revoke(parent.cid.toString());
store.endTask("summarize-42");
```

Authenticate and authorize the human calling any endpoint you put around those methods. The same requirement applies to resource registration and grant issuance. A string called `actor` is not authentication.

## Scope

The prototype supports exact, repeatable reads without caller-controlled operation arguments. Passing a grant to another worker requires that worker's own identity key to invoke it. Workers sharing keys or a broad alternative credential do not gain isolation from this library.

Revocation affects subsequent authorization decisions; it does not cancel an action already dispatched. Read results can still be disclosed by an agent. The SDK does not sandbox the operating system, prevent all prompt injection, or make an allowed action inherently desirable.

Read the [architecture](docs/architecture.md), [security model](SECURITY.md), and [roadmap](docs/roadmap.md) before integrating it.

## License

[MIT](LICENSE).
