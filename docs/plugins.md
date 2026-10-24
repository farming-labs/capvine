# Provider and resource plugins

For applications that connect accounts and select resources while running, start with the [application API](application.md). This guide covers the compatible fixed-resource setup API. Its `./resources` factories are distinct from runtime `./plugins`.

`createCapvine` composes the existing account manager, persistent authority, adapters, administration client, workflow manager, and worker provisioning APIs. Provider factories use `providers: [google(options)]`; resource factories use `resources: [filesystem(options), gmail(options)]`. All plugins are explicitly imported trusted backend code. There is no package discovery, runtime installation, or plugin sandbox.

## Run a complete example

From the repository checkout with Node 24+:

```sh
npm ci --ignore-scripts
npm run example:plugins
```

[The example](../examples/plugins/demo.ts) uses a local OIDC provider and a custom HTTP message resource. It connects an account, selects a message in protected setup, records an explicit approval, launches a separate MCP worker, reads the message, rejects a raw signed request for another resource, restarts, renews without another approval, and disables access across another restart. It verifies the returned fixture data without printing credentials. This is a fixture, not a connected Google account or a production deployment.

## One-call setup for local resources

Prepare a service-owned directory and regular text file as described in [filesystem resources](resources.md). Use a new absolute path for Capvine state on the first run; its parent directory must already exist and be protected. Install the experimental package with `npm install --save-exact @farming-labs/capvine@0.0.1`; the examples run from this checkout.

```ts
import { createCapvine, workflow } from "@farming-labs/capvine/setup";
import { filesystem } from "@farming-labs/capvine/resources";

const report = "urn:capvine:resource:report";
const app = await createCapvine({
  directory: "/private/application/capvine",
  ownerId: "application-owner",
  port: 8790,
  resources: [
    filesystem({
      root: "/private/application/reports",
      connectionId: "reports",
      files: [{ id: report, path: "daily.txt" }],
    }),
  ],
  workflows: [
    workflow({ id: "read-report", resource: report, action: "fs/read" }),
  ],
});

// Call only after the authenticated owner approves this workflow.
const approval = await app.workflows.approve("read-report");
const job = await app.workflows.provision(approval.id);
```

The application delivers only `job.path`'s private assignment to its worker. A plain worker uses `loadWorker(path).invoke()` (after awaiting `loadWorker`). An MCP runtime launches `node /absolute/path/capvine/dist/cli.js worker /absolute/path/assignment.json`. `app.workflows.renew(job.id)` replaces the proof while retaining its binding and worker identity. `app.workflows.disable(approval.id)` blocks subsequent calls and issuance. `await app.close()` drains and closes owned components.

`workflow()` supplies a one-hour approval, five-minute grants, and two-minute worker permissions. The label defaults to the workflow ID; the MCP tool name replaces its hyphens with underscores. Override `label`, `toolName`, `approvalSeconds`, `grantSeconds`, and `workerSeconds` explicitly. These are permission lifetimes, not schedules. Definitions never approve themselves.

`createCapvine` does not install an automatic renewal loop. A trusted application supervisor can call `app.workflows.renewDue()`; the existing account/workflow consoles already do that when passed the manager. See [workflow console integration](workflow-console.md). Closing a browser does not disable an approval.

## Connect an account before selecting its resources

On the first connection there is no account/message binding yet. Create the account layer, complete authenticated consent, then call `start()` once:

```ts
import { createCapvine, workflow } from "@farming-labs/capvine/setup";
import { google } from "@farming-labs/capvine/providers";
import { gmail } from "@farming-labs/capvine/resources";

const app = await createCapvine({
  directory: "/private/application/capvine",
  ownerId: "application-owner",
  providers: [
    google({
      clientId: serverSecrets.googleClientId,
      clientSecret: serverSecrets.googleClientSecret,
      redirectUri: "https://app.example.com/oauth/google/callback",
    }),
  ],
});
```

`serverSecrets` is the application's protected secret configuration, not a Capvine helper. Use `app.accounts.begin()` and `app.accounts.complete()` in authenticated, CSRF-protected owner routes, or embed the existing [account console](account-console.md). The complete example exercises these exact APIs against its local provider. The provider callback and owner authentication are still explicit application integration; `createCapvine` does not create public browser routes.

After completion, use the returned connection ID and verified subject, and a message selected by the authenticated owner:

```ts
const receipt = "urn:capvine:resource:receipt";
const resources = [
  gmail({
    messages: [
      {
        id: receipt,
        connectionId: connected.id,
        subject: connected.subject!,
        messageId: selectedMessageId,
      },
    ],
  }),
];
const workflows = [
  workflow({
    id: "read-receipt",
    resource: receipt,
    action: "gmail/message.read",
  }),
];
await app.start({ resources, workflows });
```

Persist these non-secret bindings in protected application configuration. On later starts, pass the same `providers`, `resources`, and `workflows` directly to `createCapvine`. The account is loaded from its encrypted store. A changed account/message needs a new resource ID and approval; an old ID cannot be silently retargeted. Reconnect uses a fresh connection ID. Resources are fixed for one service run; stop/restart with reviewed configuration to add or remove them. Live hot registration is not provided.

`app.start()` is only for the initial connect-then-register phase. Concurrent or repeated starts reject; after a failed start, close the app and reopen with corrected configuration. Invalid resource/workflow relationships fail before listening. Reading `app.accounts`, `app.service`, or `app.workflows` before that component is configured produces an explicit error.

## Available factories

| Entry         | Factories                                          | Contract                                                                             |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `./providers` | `google`, `oidc`, `slack`                          | Return the existing `AccountProvider`; no second token store or OAuth implementation |
| `./resources` | `filesystem`, `postgres`, `gmail`, `slackMessages` | Open existing adapters with the configured owner/account manager                     |
| `./resources` | `defineResource`                                   | Register a custom `{ name, open(context) }` factory                                  |
| `./setup`     | `createCapvine`, `workflow`                        | Compose lifecycle and validate workflow definitions                                  |

Provider options match the original provider factories, including confidential OIDC clients with explicit endpoints and Slack's PKCE rotating-user-token configuration. Automatic OIDC discovery is not implemented. Gmail and Slack resources keep their provider-specific account identity and scope checks. Multiple instances of a resource plugin may share an operation when its resource kind is identical; dispatch selects the exact registered resource's handler. Duplicate resource IDs, duplicate operations inside one plugin, cross-owner resources, and one action spanning incompatible resource kinds reject.

## Add a custom service

Use `oidc({ id, issuer, authorizationEndpoint, tokenEndpoint, userInfoEndpoint, jwksUri, clientId, clientSecret, redirectUri, scopes })` for the supported OIDC profile. A different authentication protocol implements the existing `AccountProvider` methods (`authorizationUrl`, `exchange`, `refresh`, `verify`) and passes that object in `providers`. Credentials need a stable subject, refresh token, expiry, and verified scopes. API keys and arbitrary OAuth variants are not automatically supported.

Copy [the custom message plugin](../examples/plugins/message-resource.ts) as a starting point for a resource API you control. It fixes the origin/account/message in trusted configuration, validates the connected subject, verifies the resource binding again in the handler, uses `accounts.withAccessToken()` only in trusted code, rejects redirects, bounds response time/bytes, checks the returned ID, and projects a small result. Replace its provider-specific schema and scopes deliberately. Its loopback option exists for the local fixture; production endpoints require HTTPS. Resource handlers must remain repeatable reads.

`open({ ownerId, accounts })` returns the existing `ResourceAdapter`: resources, operations, and an asynchronous `close()`. It must clean up any partially opened resources if it throws before returning. After a successful open, setup owns cleanup and calls it once during failed startup or shutdown, in reverse plugin order. Custom code has backend privileges and must be reviewed like other server dependencies; `defineResource` is not isolation.

## State and key custody

`directory` is Capvine's state folder, not a worker's allowed filesystem root. First use creates the private folder, authority state/key/operator token, coordinator key, and (by default) a random account-encryption key. The generated encryption key is a separate `accounts.key` file outside the encrypted account database. A complete copy of both still exposes credentials; this is local key custody, not a vault or protection from a compromised backend. Supply `encryptionKey: Uint8Array` from an external secret manager to keep the key outside this folder. Supply the same 32 bytes on every startup; setup never persists that external key.

An initialized directory is reused without recreating keys. An existing empty or partially initialized directory, missing key, changed owner/key mode, unreadable state, or inconsistent authority fails closed. There is no automatic adoption of state directories created by the older low-level examples. Do not delete the marker to reset permissions. Preserve the complete state/identity set and follow the [recovery runbook](deployment.md); rollback can restore disabled grants. Keys and all state must stay out of worker mounts and source control.

An exclusive `setup.lock` covers setup, accounts, and resources. Concurrent ownership rejects; after a crash verify every owning process is stopped before dealing with a stale lock. Setup does not clear stale locks based on age. Protect ancestor directories and isolate the backend OS user. File modes do not isolate processes sharing that user.

Invocation listens on loopback port 8790 by default; administration uses a separate ephemeral loopback port. Set `port` to a stable port for restarts: worker assignments and the workflow directory pin the endpoint. `port: 0` is useful for temporary examples, which must record and reuse the selected port if they restart. Remote access, TLS, authenticated owner routes, monitoring, backups and worker isolation remain deployment work. This is still a single-owner, single-process composition.

## Review evidence and remaining gates

`test/setup.test.ts` covers real file dispatch across two plugins sharing an operation, raw signed retargeting denial, immutable targets, persistent identity/approval/disable, Google/Slack fixture connections, credential separation, invalid configuration cleanup, missing/incorrect keys, concurrent ownership and shutdown during startup. The complete custom-provider example runs in CI through a separate MCP process. Existing adapter and verifier suites remain authoritative for their own contracts.

For adopter review, try the one-call file setup, connect a custom provider, add a custom resource, restart/renew, and disable a worker without reading implementation source. Record confusing configuration or lifecycle choices. For security review, inspect whether plugin dispatch ever substitutes a target or bypasses verification, whether bootstrap can replace lost state, and whether a failure leaves resources, credentials or listeners active. The [external review packet](security-review.md) includes these boundaries. Internal review and passing tests do not complete independent review, production validation, or publication approval in [issue #16](https://github.com/farming-labs/capvine/issues/16).
