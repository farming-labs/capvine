# Application starter

A standalone, single-owner application using the **published** `@farming-labs/capvine@0.0.1` package. It includes Better Auth password login, persistent SQLite state, real local files, and a separate worker that receives a delegated permission. No Google account or model API key is required.

This is an experimental local integration. It is not a supported production deployment or a sandbox for hostile worker code. It demonstrates repeatable reads only.

## Run it

Requires Node.js 24+, npm, and Linux or macOS. This folder can be copied outside the repository; it has its own package manifest and lockfile and imports no repository source.

```sh
cd examples/application/starter
npm ci
npm run setup
npm start
```

Setup asks for your owner email and a password of at least 12 characters. Password input is hidden, hashed by Better Auth, and never written as plaintext. The email is a local login identifier; this starter does not send mail or verify email ownership. Public sign-up and password-reset routes are not exposed. Preserve your password and state; account recovery is outside this example.

Open <http://127.0.0.1:8800> and sign in. There is no shared default password or console access key. Setup refuses an existing data directory instead of replacing accounts, keys, files or permissions.

Optional settings, configured **before setup**:

```sh
export CAPVINE_STARTER_DATA=/absolute/private/path/starter-data
export CAPVINE_STARTER_URL=http://127.0.0.1:8801
npm run setup
npm start
```

The origin is saved during setup. Use the same data directory on every start. Only `http://127.0.0.1:<port>` is supported by this local starter; it binds the loopback interface. Remote hosting, TLS termination and reverse-proxy trust require a separate deployment design. The server takes the rate-limit IP from its socket, replacing any caller-supplied header.

## Walk through the permission boundary

1. Sign in with the account you created. Choose `daily.txt` and explicitly approve up to one hour of reads. The initial worker grant lasts at most five minutes.
2. Click **Read approved file**. A separate worker sends a signed request to Capvine and receives the actual file contents.
3. Choose `weekly.txt` without approving a new permission. Click **Try selected file with the same key**. The worker submits a real signed request for the other resource; the server returns `denied`.
4. Click **Renew permission**. The same running worker keeps its signing key and reads the same file with a fresh grant. The previous parent is revoked, so retaining an old proof does not preserve access through that branch.
5. Click **Revoke current grant**, then read again. The worker retains its proof, but the server rejects it because the parent has been revoked. This does not cancel your one-hour approval.
6. Stop the server with Ctrl+C and run `npm start` again. Retry the read **before its original five-minute expiry**. The same worker identity and proof remain denied after restart. Click **Renew permission** to recover within the saved approval; no new approval is created.
7. Click **End workflow**. Capvine disables the saved approval, denying existing descendants and further issuance. The application also stops the worker process. Restarting does not start it again. A new job requires explicit approval.

The file selector does not change an issued permission or a renewal. Registering a file does not authorize its use. End the current workflow before approving another file, even if its current grant is revoked or expired. Signing out revokes the login session, not the worker permission. An already completed read cannot be undone.

| Control               | What changes                                                                    | What stays fixed                                                                      |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Approve selected file | Saves a one-hour approval, issues a five-minute parent and provisions a worker  | Exact file, `fs/read`, coordinator and permission service are fixed for this workflow |
| Renew permission      | Issues a fresh parent, replaces the child proof and revokes the previous parent | Worker key, process, file, operation, workflow and original approval deadline         |
| Revoke current grant  | Server rejects that parent and its descendants                                  | The saved approval can still authorize a fresh grant                                  |
| End workflow          | Server disables the workflow and the app stops its worker                       | Retained proof bytes cannot bypass the disabled workflow                              |
| Stop/restart the app  | Stops/restarts the process with its saved assignment                            | No permission is issued or renewed; revocation and disable state persist              |

## Where the integration lives

| File                    | Responsibility                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `auth.mjs`, `setup.mjs` | Better Auth configuration, schema migration and one-time owner creation.                                                            |
| `server.mjs`            | Configure `createCapvine`, mount its handler, verify owner sessions and handle the application's job controls.                      |
| `browser.mjs`           | Login, resource discovery/selection, explicit approval and result display. Uses the public Capvine owner client.                    |
| `worker-process.mjs`    | Start a separate process with a minimal environment and a private IPC channel.                                                      |
| `worker.mjs`            | Load an assignment with `loadWorker()` and invoke it.                                                                               |
| `probe.mjs`             | Demonstrate a raw, signed cross-resource request that bypasses SDK-side checks. This is a test action, not an application read API. |
| `state.mjs`             | Persist the starter's current job metadata and fixed origin. Capvine retains authority state.                                       |

Approval flows through the same public APIs as other applications:

```text
Authenticated owner selects one registered resource
  → app.api.workflows.approve (exact fs/read, coordinator identity, one hour)
  → app.api.workflows.issue (parent grant lasting at most five minutes)
  → provisionWorker (delegates that proof to a fresh worker identity)
  → private worker assignment, containing no owner session or coordinator key
  → loadWorker().invoke over HTTP
  → Capvine verifies the proof chain and current revocation state
  → filesystem plugin reads the server-bound file
```

The job-control endpoints accept resource IDs, never caller-selected credential paths, invocation URLs, signing keys or actions. The coordinator identity and operation are chosen by trusted startup/application code. Owner authentication remains the app's responsibility; the starter uses Better Auth's database-backed session checks with cookie caching disabled. Login cookies are HttpOnly and SameSite=Strict, and sessions expire after one hour. Failed login attempts are rate-limited in the database across restarts. All worker controls require the verified owner, an exact same-origin Origin header and a custom request header.

## Follow the worker lifecycle in code

`server.mjs` is the trusted coordinator. In its `approve` handler, `request.headers` come from the authenticated owner request; no owner cookie or coordinator key is delivered to the worker:

```js
const workflow = await app.api.workflows.approve({
  headers: request.headers,
  body: {
    resource: selectedResourceId,
    action: "fs/read",
    audience: coordinator.did(),
    expiresIn: 3600,
    maxGrantSeconds: 300,
  },
});
const parent = await app.api.workflows.issue({
  headers: request.headers,
  body: { id: workflow.id },
});
await provisionWorker({
  path: privateAssignmentPath,
  coordinator,
  grant: await decodeGrant(Buffer.from(parent.grant, "base64")),
  url: parent.invocationURL,
  toolName: "read_report",
  expiresAt: new Date(parent.expiresAt * 1000),
});
```

`provisionWorker` creates the worker key and delegates to it. `startWorker` launches `worker.mjs`, which loads only its assignment and signs reads using `loadWorker().invoke()`. There are two permission links: authority → coordinator → worker. The owner session authorizes issuance; it is not another worker key. You do not need a chain of agents for an ordinary background job.

The `renew` handler takes an **empty body**. It reads the saved workflow ID from trusted job state, issues a parent for that same approval, and calls `renewWorker` with the existing assignment path. The worker reloads the file on its next invocation, without restarting. The backend then revokes the previous parent and saves the new public grant metadata. Renewal cannot select another file, action, recipient, service or workflow. If installation or metadata persistence fails, the handler revokes the newly issued parent, including when the new assignment was already installed; it never restores an old proof as a fallback.

The `disable` handler first calls `app.api.workflows.disable`, then stops the worker and saves the ended state. Killing a process alone cannot invalidate copied proofs. Disabling the approval is the server-enforced step. If an assignment is damaged or missing on restart, owner login and End workflow remain available; reads and renewal are unavailable.

Renewal is manual here so each transition is visible. No scheduler is installed. It requires a current owner session and cannot extend the original one-hour approval deadline. When the deadline passes, renewals and reads fail and another explicit approval is needed. A larger application can schedule renewal under its own authenticated job policy; it must not give workers owner credentials or let a model choose arbitrary approval IDs. See [saved approvals](../../../docs/workflow-approvals.md) and [provisioned workers](../../../docs/workers.md).

Existing starter state from the one-time-grant version still loads. Those jobs cannot renew: end the old job and explicitly approve a new workflow. Upgrading never silently creates standing permission.

This single-process example uses SQLite for authority state and a separate atomic metadata file; they are not a cross-store transaction. Failed requests disable newly created approvals or revoke newly issued parents where cleanup completes. A crash or storage failure during cleanup can leave an approval or grant recorded in Capvine but absent from `job.json`. The owner can enumerate and disable saved approvals through `client.workflows.list()` / `client.workflows.disable({ id })`; consult the persistent authority state before recovering. Do not treat job display metadata as a complete permission inventory or run multiple starter servers over this directory.

## What is stored

The ignored `.data/` directory contains:

- `auth.db` and `auth-secret`: Better Auth accounts, sessions, rate limits and its signing secret.
- `settings.json`: the permitted owner ID and application origin.
- `capvine/`: Capvine authority keys, bindings, grants and revocation state.
- `coordinator.key`: the backend identity that delegates approved grants.
- `reports/`: the two sample text files. Edit their contents in place to observe real reads; replacing a registered file may invalidate its binding.
- `workers/<job-id>/assignment.json`: one worker's private key and delegated proof.
- `job.json`: the current job's resource, workflow/root identifiers, deadlines and local shutdown/revocation metadata. Authorization comes from Capvine's verifier, not this UI metadata.

Directories/files are private to the current OS user. Do not commit or serve this directory. Old assignment directories are retained; their proofs remain subject to expiry and server revocation. Treat the entire state directory as sensitive, including backups. The default key and encrypted state can reside together; copying the whole directory does not keep the copied secrets inaccessible.

**Separate processes sharing an OS user do not contain hostile code.** This starter's worker implements only read/probe commands, receives no owner cookies, and inherits no provider credentials. Before running untrusted code, arrange OS/container isolation so it cannot open authority state, other assignments, the reports folder or a logged-in owner browser directly. The existing Linux reference checks do not establish macOS computer-use containment.

## Verify

```sh
npm test
```

The integration tests install/use the pinned registry package and launch the actual application and worker processes. They exercise real password authentication, unauthenticated/non-owner/CSRF rejection, bounded request bodies, disabled sign-up, logout, persistent rate limiting, selected-file reads, raw signed cross-resource denial, renewal without identity/process replacement, retained-proof denial, restart, workflow shutdown and legacy assignments. A real filesystem failure after assignment replacement verifies that the newly installed grant is revoked; a missing assignment verifies that owner shutdown remains reachable. Tests create and remove their own private temporary state; they do not touch `.data/`.

This verification is implementation evidence, not independent adopter feedback or security review. [Adopter review #51](https://github.com/farming-labs/capvine/issues/51) remains open. This starter does not use the inspection APIs added after `0.0.1`.

For another app, keep your existing authentication, UI and job system, and replace the corresponding starter code. Start from the [application API guide](https://github.com/farming-labs/capvine/blob/main/docs/application.md), [Better Auth database/migration documentation](https://better-auth.com/docs/concepts/database) and [session documentation](https://better-auth.com/docs/concepts/session-management). Additional providers/plugins need their own credentials and validation; this starter connects no external account.
