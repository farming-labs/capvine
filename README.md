# Capvine

**Delegated, resource-bound authorization for applications and services.**

Capvine is an experimental TypeScript library from [Farming Labs](https://github.com/farming-labs). Grant a client permission to perform one operation on one resource, allow delegation with a shorter lifetime, and verify every invocation before dispatching to an application handler. Clients can be backend services, background workers, applications, or agent runtimes.

```text
Owner policy → grant for A → narrower grant for B
                                         ↓
                             signed invocation + proofs
                                         ↓
                     Capvine verification + lifecycle checks
                                         ↓
                           application resource handler
```

Capvine builds on [ucanto](https://github.com/storacha/ucanto). Applications supply owner authentication, issuance policy, resource handlers, and upstream credentials. Existing roles or ACLs can inform issuance policy. The library does not replace database permissions or provide native database authorization; examples include simulated APIs and an optional live public GitHub read.

## Status

This repository contains the first working prototype. The package is private to prevent accidental npm publication; the source is MIT licensed. APIs may change. It has not had an independent security review.

Implemented:

- Signed owner-authorized grants and parent-to-child delegation.
- Exact resource, operation, task, and receiving-service restrictions.
- Expiration, parent/child revocation, and task termination.
- Memory and SQLite state stores, with audit outcomes.
- Saved owner-approved workflows with short-lived grant renewal and persistent disable.
- Serialized proof archives and a transport callback for embedding in a backend.
- A bounded Node HTTP handler and client transport.
- A container reference check that tests worker credential and network isolation in Linux CI.
- A validated server command combining real file and PostgreSQL reads through one permission path.
- Registered-file and PostgreSQL-record adapters with bounded reads and protected target bindings.
- A live read-only GitHub issue connector and a provisioned per-worker MCP bridge.
- Private worker assignments, a stdio worker CLI, and renewal that preserves each worker's exact scope and identity.
- A reusable local workflow console for fixed permissions, persistent approval, separate worker provisioning, automatic renewal, and disable.
- Direct OAuth/OIDC account connections, encrypted local credentials, serialized token refresh, and a bound Gmail reader.
- A Slack PKCE account provider with rotating user tokens and exact conversation/message reads, validated against an HTTP fixture.
- An authenticated local account console with OAuth callbacks, connection management, session/CSRF controls, and an opt-in Gmail delegation test screen.
- A persistent local service with authenticated operator administration, pinned resource bindings, and restart checks.
- An application API with authenticated owner routes, a typed client, runtime resource registration, and persistent grant revocation.
- A plugin setup API with provider/resource factories, persistent initialization, and a connect-before-register workflow.
- In-process and separate-process issue-reading examples, plus tests that bypass the client to attack server enforcement.

Not implemented: a production service deployment, multi-user account management, macOS desktop isolation, write-operation replay protection, budgets, or a managed service. Direct account connection and refresh are tested against a local OAuth/OIDC provider fixture; a configured local Google smoke test has also verified consent, refresh, delegated reads, restart, and revocation. Provider-consent revocation and production isolation remain unverified. The live GitHub example uses public data.

The [resource server command](docs/server-command.md) combines both adapters. Run `npm run example:resources` for the full separate-process demonstration, including revocation and restart. PostgreSQL as a protected resource is separate from storage for Capvine's own permission state. The [roadmap](docs/roadmap.md) and [release readiness checklist](docs/release-readiness.md) retain the remaining external review, production deployment, and publication gates.

## Run the example

Requires Node.js 24 or later and npm. The full test suite also requires PostgreSQL 14+ server binaries available through `pg_config` and a non-root test user; it creates its own temporary clusters.

```sh
git clone https://github.com/farming-labs/capvine.git
cd capvine
npm ci
npm run check
npm run example
npm run example:network -- --workers 3
npm run example:service
npm run example:resources
npm run example:accounts
npm run example:slack
npm run example:plugins
npm run example:application
npm run example:recovery
```

The first example creates a permission for A, delegates it to B, reads one fixture issue, and demonstrates that revoking A's grant stops B's next call. No external account or model API key is needed.

For a browser walkthrough, run `npm run playground` and open **http://127.0.0.1:8788/**. The [delegation playground](examples/delegation-playground/README.md) lets you approve, delegate, read, attempt forbidden requests, and revoke a parent grant. It uses real separate-process signing and server verification with simulated provider data; it does not use connected accounts or replace a production approval UI.

The [network example](examples/network/README.md) runs an authority, coordinator, and three workers in separate processes. Each worker reads only its assigned issue over HTTP. Changing the issue, action, or task fails. Revoking one root leaves independent grants working; ending the task disables all of them. Try `--workers 8` to increase fan-out. This is a correctness demonstration, not a capacity benchmark or OS sandbox.

## The developer integration

Start with the [application API guide](docs/application.md): configure providers and plugins once, mount `capvine.handler`, then use `createCapvineClient()` to connect accounts, register selected resources, issue grants, and revoke access. `npm run example:application` exercises OAuth, exact-resource registration, separate-process delegation, restart, and revocation over HTTP with a local provider fixture. The application supplies verified owner sessions. This remains a single-owner read-only prototype; independent security review and production validation remain open.

The existing [fixed-resource setup API](docs/plugins.md) remains available for `createCapvine({ directory, providers, resources, workflows })`, including saved approvals, worker provisioning, and renewal. Its custom OIDC/MCP example is `npm run example:plugins`. Plugins in both APIs are explicitly imported trusted backend code.

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

`transport` sends serialized invocation bytes to `authority.execute` in your backend. Use `createHttpTransport` and `createHttpHandler` from the `./http` entry to cross a process boundary, as in the network example. Separate processes under the same OS user are not an isolation boundary for arbitrary untrusted code; deployment must restrict access to authority state, keys, and alternate credential paths.

The [integration guide](docs/integration.md) describes resource registration, grant issuance, service integration, and worker delegation. It separates the implemented HTTP boundary from proposed database and runtime adapters.

See the [GitHub and MCP guide](docs/connectors.md), `npm run example:github`, and `npm run example:mcp` for the implemented integrations.

Run `npm run console:accounts -- --fixture` for the [browser account console](docs/account-console.md), or configure a real Google web client using its guide. The console is local and single-owner. Its Gmail screen lets the owner select one inbox message, approve and delegate an exact read, inspect the real response, and test revocation. Connecting an account alone never issues a grant.

The [direct account guide](docs/accounts.md) covers `npm run example:accounts`, OAuth callback integration, encrypted credential storage, refresh, and Gmail resource registration. Workers receive grants; provider credentials stay in the trusted account manager.

The [Slack guide](docs/slack.md) covers the separate OAuth v2 PKCE provider and message adapter. `npm run example:slack` exercises a local fixture through direct and separate-process MCP workers, refresh, restart, and revocation. Live Slack workspace validation remains open.

The [saved workflow guide](docs/workflow-approvals.md) shows how to approve an exact scope once, issue fresh grants automatically from trusted application code, and disable all dependent grants. It reuses the same permission path with any registered adapter.

Run `npm run console:workflows` for the [workflow approval console](docs/workflow-console.md), which connects saved owner approvals to real separate workers reading a local example file.

The [worker provisioning guide](docs/workers.md) connects those approvals to separate worker processes through `provisionWorker`, `renewWorker`, and `capvine worker`. Run `npm run example:mcp` to read a real file, restart the authority, renew a running worker, and disable its workflow.

The [provider validation command](docs/provider-validation.md) runs a selected real message through a separate MCP worker and checks restart and local revocation without printing its contents. The [deployment and recovery runbook](docs/deployment.md), [external review packet](docs/security-review.md), and [release bundle procedure](docs/release-runbook.md) prepare the remaining release gates; they do not mark those gates complete.

## Persist state

The [persistent service guide](docs/service.md) shows one-time identity/state initialization, authenticated grant issuance, and restart behavior. The operator token belongs only in protected application code; workers receive their own signing identities and scoped grants.

Use `SqliteStore` from the `./sqlite` entry in place of `MemoryStore`. It stores resources, tasks, workflow approvals, issued root grants, revocations, and audit outcomes. Preserve the service identity across restarts through your existing secret store. The database contains no signing keys or provider credentials.

Store administration is privileged application code:

```ts
store.revoke(parent.cid.toString());
store.endTask("summarize-42");
```

Authenticate and authorize the caller of any endpoint exposing those methods. The same requirement applies to resource registration and grant issuance. A string called `actor` is not authentication.

## Scope

The prototype supports exact, repeatable reads without caller-controlled operation arguments. Passing a grant to another worker requires that worker's own identity key to invoke it. Workers sharing keys or a broad alternative credential do not gain isolation from this library.

Revocation affects subsequent authorization decisions; it does not cancel an action already dispatched. A recipient can still disclose returned data. The SDK does not sandbox the operating system or guarantee that a permitted operation is appropriate for the application's purpose.

Read the [architecture](docs/architecture.md), [security model](SECURITY.md), and [roadmap](docs/roadmap.md) before integrating it.

## License

[MIT](LICENSE).
