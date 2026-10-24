# Application API

Configure supported services once. Connect accounts, select exact resources, and grant access while the application runs. This API uses the existing account manager, resource adapters, SQLite state, and UCAN verifier. It does not require Better Auth; an application can use Better Auth or another verified session system for owner authentication.

The package is still private and unpublished. Run `npm run example:application` from the checkout for a complete HTTP example with a local OAuth fixture and separate coordinator/worker processes. It checks selected-message access, raw cross-resource denial, restart without another consent, and persistent parent revocation. It connects no real Google account and does not demonstrate OS isolation.

## Configure the backend

```ts
import { createCapvine } from "@farming-labs/capvine/setup";
import { google } from "@farming-labs/capvine/providers";
import { gmail, filesystem } from "@farming-labs/capvine/plugins";
import { auth } from "./auth.js";

export const capvine = await createCapvine({
  baseURL: "http://localhost:3000",
  ownerId: process.env.CAPVINE_OWNER_ID!,
  storage: {
    directory: "/private/application/capvine",
  },
  async authenticate(request) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;
    return { ownerId: session.user.id, sessionId: session.session.id };
  },
  providers: [
    google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  plugins: [
    gmail(),
    filesystem({ id: "reports", root: "/private/application/reports" }),
  ],
});
```

In this example `auth` is an existing Better Auth instance owned by the application. `CAPVINE_OWNER_ID` is that application's one allowed user's ID. Capvine compares every authenticated owner ID with this configured value. `authenticate` must verify the session, including expiry/revocation, before returning anything; never copy IDs from a request body or unverified headers. `sessionId` must identify the individual login session, not merely the user. Capvine hashes that verified identifier before binding OAuth state to it. The application owns login/logout and secure session cookies; use HttpOnly, Secure in production, and an appropriate SameSite policy. A top-level OAuth return requires the owner session to be available on that callback.

This remains single-owner software. Supplying a general login system does not add multi-tenant isolation.

Google's callback URI is derived as `http://localhost:3000/api/capvine/callback`; register that exact URI in Google Cloud. `google`, `slack`, and `oidc` accept an omitted `redirectUri` in this application API. An explicitly configured provider must use the same callback URI. Google requests the existing `openid` and Gmail read-only scopes. Additional services need their own scopes and resource plugins. OIDC still requires explicit endpoints; discovery is not implemented.

`storage.directory` holds Capvine's state, keys, and encrypted account database. It is unrelated to the files a worker may read. Use a new absolute directory on first setup and preserve it on later starts. The existing private-file, key-custody, and recovery rules in [the setup guide](plugins.md#state-and-key-custody) apply. `storage.encryptionKey` optionally supplies an external 32-byte key. The default key is stored separately from the encrypted account database in this directory; copying the entire directory also copies that key. SQLite stores the application origin/owner binding and immutable resource registrations transactionally. Reopening the same state with a different origin rejects rather than redirecting existing workers to a different deployment.

## Mount one handler

`capvine.handler(request)` takes a standard `Request` and returns a `Promise<Response>`. Mount it at `/api/capvine/*` in the same origin as your owner application. It does not listen on a port itself.

For Node's HTTP server:

```ts
import { createServer } from "node:http";
import { toNodeHandler } from "@farming-labs/capvine/node";

const server = createServer(
  { headersTimeout: 5000, requestTimeout: 10000 },
  toNodeHandler(capvine, { baseURL: "http://localhost:3000" }),
);
server.listen(3000, "127.0.0.1");
```

This snippet mounts Capvine only. A complete application also serves its existing login routes and owner UI. The [complete example](../examples/application/demo.ts) demonstrates the HTTP integration with a fixture session. Do not reuse its fixed fixture-session checker as a login system.

Owner operations are JSON POSTs requiring an exact same-origin `Origin`, the `X-Capvine-Request: 1` header, and the authenticated owner session. Cross-origin and same-site sibling-origin requests reject. No CORS access is enabled. The OAuth GET callback is exempt from POST CSRF headers and instead verifies the owner session and single-use OAuth state through the existing account manager. Return destinations must be application-relative, same-origin paths outside `/api/capvine`.

The `/api/capvine/invoke` endpoint accepts serialized signed capability requests, independently of the owner session. It uses the existing verifier and rejects browser-origin requests. Keep owner cookies and the logged-in owner browser outside worker access. Giving a worker that session would also give it the owner’s approval authority. Owner cookies or a resource ID cannot substitute for a worker proof. A worker grant cannot substitute for the owner session on administration routes.

## Connect, select, grant

Create a browser client in a separate module. Do not import the backend instance, provider credentials, or storage configuration into the browser.

```ts
import { createCapvineClient } from "@farming-labs/capvine/client";

export const client = createCapvineClient({
  baseURL: "http://localhost:3000",
});
```

The owner must already be signed into your application. A Connect Google button can call:

```ts
await client.connections.connect({
  provider: "google",
  returnTo: "/settings/connections",
});
```

In a browser the client navigates to the authorization URL. OAuth finishes after the browser returns; this call does not synchronously return a connected account. On the returned page:

```ts
const { connections, nextCursor } = await client.connections.list();
```

Show the connected entries in your account picker. When the owner selects an account and a message:

```ts
const receipt = await client.resources.register({
  type: "gmail.message",
  connectionId: selectedConnection.id,
  target: { messageId: selectedMessage.id },
});
```

`selectedConnection` and `selectedMessage` are selections in the application's UI, not Capvine functions. This API registers known IDs. Use `client.resources.discover` or the optional [owner console](owner-console.md) to select supported resources; arbitrary service objects are not automatically enumerated. The backend resolves the account's verified provider identity, and generates and stores the exact resource ID. The request cannot supply its own owner, resource ID, account subject, URL, or credentials.

Registration alone gives workers no permission. After the owner approves the exact resource, action and worker identity:

```ts
const grant = await client.grants.issue({
  resource: receipt.id,
  action: "gmail/message.read",
  audience: worker.did,
  expiresIn: 300,
});
```

`worker.did` is the public `did:key` identity generated by the worker's signing key. Deliver the returned grant to that worker through the application's assignment channel. The response contains `id`, a base64 `grant` archive, the resource/action/audience, an `expiresAt` Unix timestamp in seconds, the service DID, and `invocationURL`. It contains neither the worker's private key nor provider credentials. The server creates and binds the authorization task internally. Grants default to five minutes and cannot exceed one hour. Issuing a grant is an owner-authorized decision, not an automatic result of connecting an account, registering a resource, or receiving a model suggestion.

## Use and delegate from a worker

The worker uses the existing capability client, not the owner client:

```ts
import { createClient, decodeGrant, identity } from "@farming-labs/capvine";
import { createHttpTransport } from "@farming-labs/capvine/http";

const workerClient = createClient({
  signer: workerIdentity,
  service: identity.Verifier.parse(grant.service),
  transport: createHttpTransport({ url: grant.invocationURL }),
});
const permission = await decodeGrant(Buffer.from(grant.grant, "base64"));
const result = await workerClient.invoke(permission);
```

`workerIdentity` is the recipient's private signing identity, retained by that worker. `identity.Verifier.parse` expects a `did:key` string; validate externally received metadata at your assignment boundary. The existing `workerClient.delegate({ grant: permission, audience: anotherWorker, expiresAt })` creates a child with the same resource/action/task/service and a lifetime no longer than its parent. The current profile does not permit widening or combining resources.

The owner can revoke the root, including its descendants:

```ts
await client.grants.revoke({ id: grant.id });
await client.connections.disconnect({ connectionId: selectedConnection.id });
```

Revocation blocks subsequent verified calls; it cannot undo a completed read or recall already returned data. Disconnect removes local provider credentials and blocks account-backed resources; it does not claim to revoke consent at Google or Slack. Reconnect creates a fresh connection ID and requires fresh resource selection and grants. For repeat work, use the saved workflows below; the existing [lower-level workflow APIs](workflow-approvals.md) remain compatible.

## Approve once and renew within that permission

A saved workflow fixes one resource, action and recipient. The owner explicitly approves its total lifetime (up to 30 days) and the lifetime of each proof (up to one hour):

```ts
const workflow = await client.workflows.approve({
  resource: receipt.id,
  action: "gmail/message.read",
  audience: coordinator.did,
  expiresIn: 24 * 60 * 60,
  maxGrantSeconds: 300,
});
const grant = await client.workflows.issue({ id: workflow.id });
```

`issue` accepts only the saved ID. It cannot change the resource, recipient, operation or expiry limit. Reopening the application preserves approvals. `workflows.list()` returns paginated metadata; `workflows.disable({ id })` permanently ends the workflow task and blocks existing descendants and future renewal. Revoking one proof with `grants.revoke` does not disable its saved approval: disable the workflow to stop all future issuance.

Opt into serial renewal in the authenticated owner application:

```ts
const controller = new AbortController();
const renewal = client.workflows.maintain({
  id: workflow.id,
  signal: controller.signal,
  onGrant: (grant) => deliverToAssignedCoordinator(grant),
});
// Attach error handling immediately; failed delivery or renewal stops the loop.
renewal.catch(showRenewalError);
// When this application component shuts down:
controller.abort();
await renewal;
```

`deliverToAssignedCoordinator` is your application's protected assignment channel. The coordinator can use the existing `renewWorker` API to replace a child's proof without changing its identity or scope. Do not send owner cookies, provider tokens or a signing key with the grant. `maintain` requests a fresh proof before expiry, waits for delivery before scheduling the next request, and stops on authentication, storage, provider or delivery failure. It does not silently retry or revive disabled workflows. Aborting stops future delivery/renewal; an already issued grant stays valid until revoked or expired. The promise resolves on abort and rejects on a failure; a pending bounded HTTP request may finish before shutdown completes.

The loop requires the existing authenticated owner session on every request. It can run while the owner application is active; it is not a durable unattended scheduler and does not keep a login session alive. A host scheduler must supply a verified authorized application session and protect its assignment channel. A worker cannot renew using just a workflow ID, and must never receive the owner's session. Browser throttling or host downtime can interrupt renewal; resume deliberately from the saved approval after authentication. `capvine.api.workflows.approve/list/issue/disable` expose the same checks to backend integrations.

## Other plugins and custom services

| Plugin                                     | Registered `type` | `target`                                        | Action               |
| ------------------------------------------ | ----------------- | ----------------------------------------------- | -------------------- |
| `gmail()`                                  | `gmail.message`   | `{ messageId }`, plus `connectionId`            | `gmail/message.read` |
| `slackMessages()`                          | `slack.message`   | `{ channelId, timestamp }`, plus `connectionId` | `slack/message.read` |
| `filesystem({ id, root })`                 | `fs.file`         | `{ path: "daily.txt" }`                         | `fs/read`            |
| `postgres({ id, databaseId, connection })` | `pg.record`       | `{ schema, table, key, tenant, columns }`       | `pg/record.read`     |

Providers use `./providers`; these runtime resource plugins use `./plugins`. Multiple instances of the same resource type require an explicit `plugin` ID in registration. Filesystem roots and PostgreSQL connections stay in trusted startup configuration. Callers cannot choose another root, host, database connection, URL, or arbitrary SQL. PostgreSQL requires explicit `host`, `database`, and `user` options; connection strings and implicit environment-based target selection are unsupported here. Its existing restricted-reader-role and database-identity checks still apply.

Adding another file/message/record generates another immutable ID and needs its own grant. Existing IDs cannot be updated or reused for new targets. File binding includes inode/device/birth identity; an open descriptor continues to refer to its original file, and reopening a replaced path rejects. Changing or removing a plugin's configuration makes affected registrations unusable rather than silently retargeting them. Restore the original configuration or select a new resource deliberately.

`definePlugin({ id, type, configuration, actions, open(context) })` supports application-owned services. `open({ id, ownerId, accounts, selection })` returns one existing `ResourceAdapter` for that generated ID and exact selection. Capvine validates ownership, kind, operations, and persisted binding before dispatch. The plugin validates its target schema, upstream account identity, endpoint, and returned data. `configuration` is a stable non-secret fingerprint/version of all target-affecting trusted settings; change it when those settings or binding semantics change. Plugins are privileged code, not a sandbox. Failed opens must release partially allocated resources; returned adapters are closed on validation failure or application shutdown. Only repeatable reads are supported.

## Backend methods, errors, and lifecycle

The same operations are available as `capvine.api.connections.*`, `capvine.api.resources.*`, and `capvine.api.grants.*`. Backend methods take `{ headers, body }`; pass the authenticated request's headers, including its verified same-origin `Origin`. They run through the same request handler and do not bypass session/CSRF checks.

```ts
const resource = await capvine.api.resources.register({
  headers: request.headers,
  body: { type: "fs.file", plugin: "reports", target: { path: "daily.txt" } },
});
```

Both clients throw `CapvineAPIError` with `status` and `code`. Authentication is 401, forbidden access is 403, invalid selection is 400, and busy/closing responses are 429/503. Failures do not expose provider tokens, provider response bodies, or filesystem errors. Calls are bounded to 16 active requests, 32 KiB owner bodies, 64 KiB invocations and 1 MiB invocation results. Resource registration is bounded to 256 exact items. Connection and resource lists are paginated, 25 per page, using `nextCursor` as `after`. Resource deletion, batch grants, groups and writes are not implemented. Owner-only discovery is available for plugins that define it; see [resource selection](owner-console.md).

Call `await capvine.close()` during shutdown; it rejects new calls, drains pending requests, closes adapters, and releases the store lock. The application owns its HTTP server and must close it separately. Reopen with the same state, origin and owner; accounts, bindings and revocations persist. This is a long-lived Node process with local state, not a multi-replica or ephemeral-serverless adapter. Supply TLS, ingress limits/timeouts, a verified owner-session integration, backups and worker isolation for any real deployment. Independent security review and production validation remain open.

The older `createCapvine({ directory, resources, workflows })` API and its `./resources` factories remain compatible. They use fixed startup registrations. The application API selects the new lifecycle through `storage`, `authenticate`, and `plugins`; do not mix the two option sets.
