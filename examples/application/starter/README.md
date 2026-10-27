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

1. Sign in with the account you created. Choose `daily.txt` and explicitly approve its read for five minutes.
2. Click **Read approved file**. A separate worker sends a signed request to Capvine and receives the actual file contents.
3. Choose `weekly.txt` without approving a new permission. Click **Try selected file with the same key**. The worker submits a real signed request for the other resource; the server returns `denied`.
4. Click **Revoke permission**, then read again. The worker retains its original proof, but the server rejects it because the parent has been revoked.
5. Stop the server with Ctrl+C and run `npm start` again. Retry the read **before its original five-minute expiry**. The same worker identity and proof remain denied after restart. Waiting until expiry would not establish that revocation persisted.

The file selector does not change an issued permission. Registering a file does not authorize its use. A current unexpired permission must be revoked before approving a replacement. Signing out revokes the login session, not the worker permission. An already completed read cannot be undone.

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
  → app.api.grants.issue (exact fs/read, coordinator identity, five minutes)
  → provisionWorker (delegates that proof to a fresh worker identity)
  → private worker assignment, containing no owner session or coordinator key
  → loadWorker().invoke over HTTP
  → Capvine verifies the proof chain and current revocation state
  → filesystem plugin reads the server-bound file
```

The job-control endpoints accept resource IDs, never caller-selected credential paths, invocation URLs, signing keys or actions. The coordinator identity and operation are chosen by trusted startup/application code. Owner authentication remains the app's responsibility; the starter uses Better Auth's database-backed session checks with cookie caching disabled. Login cookies are HttpOnly and SameSite=Strict, and sessions expire after one hour. Failed login attempts are rate-limited in the database across restarts. All worker controls require the verified owner, an exact same-origin Origin header and a custom request header.

No renewal scheduler is installed. Each approval lasts five minutes; a fresh approval is explicit. Saved workflows and renewal are already available in Capvine, but wiring them into this starter belongs to a later increment.

## What is stored

The ignored `.data/` directory contains:

- `auth.db` and `auth-secret`: Better Auth accounts, sessions, rate limits and its signing secret.
- `settings.json`: the permitted owner ID and application origin.
- `capvine/`: Capvine authority keys, bindings, grants and revocation state.
- `coordinator.key`: the backend identity that delegates approved grants.
- `reports/`: the two sample text files. Edit their contents in place to observe real reads; replacing a registered file may invalidate its binding.
- `workers/<job-id>/assignment.json`: one worker's private key and delegated proof.
- `job.json`: the current job's identifiers and display metadata. Authorization comes from Capvine's verifier, not this UI metadata.

Directories/files are private to the current OS user. Do not commit or serve this directory. Old assignment directories are retained; their proofs remain subject to expiry and server revocation. Treat the entire state directory as sensitive, including backups. The default key and encrypted state can reside together; copying the whole directory does not keep the copied secrets inaccessible.

**Separate processes sharing an OS user do not contain hostile code.** This starter's worker implements only read/probe commands, receives no owner cookies, and inherits no provider credentials. Before running untrusted code, arrange OS/container isolation so it cannot open authority state, other assignments, the reports folder or a logged-in owner browser directly. The existing Linux reference checks do not establish macOS computer-use containment.

## Verify

```sh
npm test
```

The integration tests install/use the pinned registry package and launch the actual application and worker processes. They exercise real password authentication, unauthenticated/non-owner/CSRF rejection, bounded request bodies, disabled sign-up, logout, persistent rate limiting, selected-file reads, raw signed cross-resource denial, unchanged worker assignments across restart and revocation before expiry. Tests create and remove their own private temporary state; they do not touch `.data/`.

This verification is implementation evidence, not independent adopter feedback or security review. [Adopter review #51](https://github.com/farming-labs/capvine/issues/51) remains open. This starter does not use the inspection APIs added after `0.0.1`.

For another app, keep your existing authentication, UI and job system, and replace the corresponding starter code. Start from the [application API guide](https://github.com/farming-labs/capvine/blob/main/docs/application.md), [Better Auth database/migration documentation](https://better-auth.com/docs/concepts/database) and [session documentation](https://better-auth.com/docs/concepts/session-management). Additional providers/plugins need their own credentials and validation; this starter connects no external account.
