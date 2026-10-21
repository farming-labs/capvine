# Persistent service and administration

The `./service` entry composes the existing verifier, HTTP transport, SQLite state, and authenticated operator administration. Run `npm run example:service` for a temporary local demonstration. Applications still provide trusted resource bindings and operation handlers; the [configuration-file application](server-command.md) composes built-in filesystem and PostgreSQL adapters.

## Bootstrap and start

```ts
import { initializeService, startService } from "@farming-labs/capvine/service";

// Run once in protected operator setup. The directory must not exist.
const serviceDid = await initializeService(
  "/private/capvine-state",
  "owner-id",
);

const service = await startService({
  directory: "/private/capvine-state",
  owner: "owner-id",
  resources,
  operations,
});
```

Initialization creates a directory with mode `0700`, an Ed25519 identity, a random administration token, and a SQLite database with mode `0600`. Key files and state are unencrypted. The supported platforms are Linux and macOS. Protect ancestor directories and run the authority under an OS identity inaccessible to clients; file modes do not isolate processes sharing a user.

Startup requires these files to exist with private ownership/modes and rejects symlinked or multiply linked files. It checks key consistency and binds the database to the authority DID and configured owner. It never generates a replacement key on startup failure. Configuration cannot retarget an existing resource ID. Removing a resource from configuration disables its dispatch and issuance, even though its historical binding remains in the database. Register a new ID for a different target.

The process creates an exclusive `service.lock` and refuses concurrent ownership of the state directory. After an unclean exit, an operator must establish that the old process is stopped before removing this file. Initialization failures can leave a partial directory; inspect it rather than overwriting it automatically.

Both listeners bind only to `127.0.0.1`, with separate invocation and administration ports. The returned `service.principal`, `service.url`, and `service.administrationUrl` identify the running service. Configure a trusted TLS proxy and network admission policy before exposing the invocation endpoint remotely. Keep the administration listener private; it is not a browser login or multi-tenant authorization service.

## Administer and delegate

```ts
import { createAdministrationClient } from "@farming-labs/capvine/administration";

const admin = createAdministrationClient({
  url: service.administrationUrl,
  token: operatorSecret,
});
await admin.createTask("job-42");
const parent = await admin.issue({
  audience: workerIdentity,
  taskId: "job-42",
  resource: "urn:capvine:resource:record42",
  action: "record/read",
  expiresAt: new Date(Date.now() + 10 * 60_000),
});
```

The token authenticates one configured operator/owner. The server supplies that owner to the issuance policy; request fields cannot override it. Only configured resources with matching ownership and registered operations can receive root grants. Root grants issued through this endpoint last at most one hour. The token permits broad administration within this one service: never provide it to a worker, model, tool, or untrusted browser.

Give the worker its own identity, the pinned service identity/endpoint, and the serialized grant. It uses the existing `createClient().invoke()` and `delegate()` APIs; it never needs the administration token. Delegation within an existing grant does not require another admin request or human approval. A new root grant does require the authenticated operator/application policy. The [saved workflow API](workflow-approvals.md) lets that application issue new grants from a persisted owner approval without a new human prompt; it is available on both `startService` and `startResourceServer`.

`admin.revoke(rootCid)` revokes a recorded root and its descendants. `admin.endTask(taskId)` disables the task. Child CIDs remain revocable through the privileged embedded store API, but the operator HTTP endpoint accepts only recorded roots. `admin.audit()` returns the most recent 100 invocation outcomes. Results contain no signing keys, bearer tokens, or resource contents; this is not a complete administration-change ledger.

Administration accepts only bounded JSON `POST /admin` commands and refuses browser Origin headers. Both clients refuse redirects and require HTTPS outside loopback. A leaked administration token grants administrative authority; the format check cannot establish token entropy. Use the generated value.

## Persistence and shutdown

Saved workflow approvals use the existing records table and create their lifecycle task in the same transaction; no additional SQL schema migration is needed.

SQLite schema version 1 adds service metadata to the original prototype's three tables. The store migrates the known version-0 layout transactionally and preserves records, revocations, and audit entries. Unknown schemas/versions fail closed. Populated legacy state without service metadata cannot be attached to the service automatically: migration needs an explicit identity/ownership review. Fresh service state is bound during initialization.

Back up the identity and database as one protected set while the service is stopped. Restoring older state can undo later revocations; a backup is not a revocation recovery mechanism. Do not reuse old grants after a rollback without resolving this explicitly.

Rotate the operator token while the service is stopped using a newly generated 32-byte base64url value in a mode-`0600` file. Restart to load it. Authority-key replacement is deliberately rejected against existing bound state; a new authority requires a new state directory, new pinned service identity, and new grants. There is no transparent key-rotation protocol.

`await service.close()` stops admission, closes listeners, and drains pending work before closing SQLite. It may disconnect HTTP clients after five seconds but still waits for dispatched handlers to finish. Handlers must impose execution deadlines and release their own resources afterward. A disconnected client does not cancel an authorized operation.
