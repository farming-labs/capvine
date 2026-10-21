# Resource adapters

Adapters initialize protected connections and return `{ resources, operations, close }`, implementing `ResourceAdapter` from `./adapter`. They use the existing `Operation.execute(resource)` seam; they do not parse capability proofs or introduce another authorization path. `startResourceServer` composes initialized adapters with the persistent service and closes them after the service drains. Startup failures close all supplied adapters. Callers must clean up earlier adapters if a later adapter fails before composition.

Operation names and resource IDs must be unique across the configured adapters. The service refuses conflicting persistent resource bindings, duplicate operations/resources, and resources without a matching operation kind. An adapter must independently validate that the received resource matches its initialized binding before performing effects. Adapter implementations, configuration, and credentials are trusted code/data.

## Registered text files

```ts
import { createFilesystemAdapter } from "@farming-labs/capvine/filesystem";
import { startResourceServer } from "@farming-labs/capvine/adapter";

const files = await createFilesystemAdapter({
  root: "/private/application-data",
  connectionId: "application-files",
  ownerId: "owner-id",
  files: [{ id: "urn:capvine:resource:report", path: "reports/latest.txt" }],
});
const server = await startResourceServer({
  directory: "/private/capvine-state",
  owner: "owner-id",
  adapters: [files],
});
```

After ordinary authenticated administration issues an `fs/read` grant for that resource, the client calls `client.invoke(grant)` and receives UTF-8 text. The request has no path argument. Limits are 256 registered files and 128 KiB per read (configurable downward). Invalid UTF-8, oversized files, directories, missing files, symbolic links, and hard links fail closed. Reads allocate only the configured bound plus one byte and use independent offsets, so concurrent readers do not share a seek position.

### File identity and deployment boundary

Supported platforms are Linux and macOS, with ordinary local filesystems. The configured root and intermediate directories must belong to the service user and disallow group/other writes. The files must also belong to that user, have one link, and disallow group/other writes. Protect the root's ancestors from untrusted changes as part of deployment. Workers must run outside that OS identity and must not be able to write these directories or files. Network filesystems, hostile writers sharing the service UID, and untrusted mount management are outside this adapter's supported boundary.

The adapter rejects traversal components and symlinked path components, opens the final file with `O_NOFOLLOW`, checks the opened descriptor, and retains that descriptor. **Protection against a parent-directory swap during initialization relies on those directories being protected from untrusted writers.** Checking names alone would not establish that boundary. A deployment requiring hostile mutable ancestors needs an OS-enforced resolution mechanism such as a separately designed Linux `openat2` implementation.

Replacing the pathname after initialization does not retarget a running grant: reads continue from the original opened file. Removing its last link makes subsequent reads fail. In-place edits by the trusted application are visible; detected metadata changes during a read reject that read. This is not a filesystem snapshot or a transactional read guarantee.

The persisted binding includes the canonical root, relative path, device, inode, and birth timestamp. After restart, a replacement file conflicts with the old binding and cannot silently receive its grants. Operators must register a new resource ID after an intentional atomic replacement. This is local OS file identity, not a portable content identifier or protection against a malicious filesystem. Backups/restores must account for changed file identities.

`test/filesystem.test.ts` exercises real files, concurrent reads, link/traversal rejection, file replacement during service lifetime and across restart, content limits, UTF-8 rejection, HTTP grant invocation, and revocation. It does not claim containment of arbitrary code running as the service user.

## PostgreSQL

`createPostgresAdapter` from `./postgres` provides `pg/record.read`, using a protected `pg` pool and one configured record/tenant/projection per resource. It has no SQL or parameter argument supplied by the client.

```ts
const database = await createPostgresAdapter({
  connectionId: "application-db",
  databaseId: "application-db-identity",
  ownerId: "owner-id",
  connection: { connectionString: protectedDatabaseUrl },
  records: [
    {
      id: "urn:capvine:resource:invoice42",
      schema: "billing",
      table: "invoices",
      key: { column: "id", value: "42" },
      tenant: { column: "tenant_id", value: "tenant-a" },
      columns: ["id", "status", "total"],
    },
  ],
});
```

Include this adapter with the file adapter in `startResourceServer`. A separate grant is required for each resource. The same `client.invoke(grant)` returns a JSON object or `null` for a missing record. Duplicate matching records reject. Identifiers are restricted and quoted; key and tenant values are parameters. `SELECT FROM ONLY` excludes inherited tables. Ordinary tables are supported; views, partitioned tables, arbitrary SQL, functions, and writes are excluded.

### Database setup and identity

An administrator provisions a stable logical database identity separately from the reader role. This prevents accidentally pointing the same connection name at an unrelated database and accepting old grants there:

```sql
CREATE SCHEMA capvine;
CREATE TABLE capvine.database_identity (id text PRIMARY KEY);
INSERT INTO capvine.database_identity VALUES ('application-db-identity');
GRANT USAGE ON SCHEMA capvine, billing TO application_reader;
GRANT SELECT ON capvine.database_identity TO application_reader;
GRANT SELECT (id, tenant_id, status, total)
  ON billing.invoices TO application_reader;
```

Use a separately owned table with exactly one identity row. Give a new logical database a new identity. Copies intentionally keeping the identity represent the same logical resource; operators must not reuse it for unrelated data. This identity is not a replacement for TLS and authenticated database connections. Connection configuration and the database administrator remain trusted.

The adapter checks this identity and role privileges on every read, binds the resource to the target table OID, and holds an access-share lock while checking and querying that table. Replacing the table rejects old bindings, including after authority restart. Reader roles must not be superusers, table owners, replication administrators, role/database creators, or RLS-bypass roles; write privileges on the registered tables are rejected. Keep the role restricted across the entire database and retain RLS where appropriate. These checks are not an exhaustive audit of role memberships, extensions, or security-definer functions. The adapter does not make an otherwise privileged database credential safe to hand to a worker.

### Bounds and failures

Queries run in read-only transactions with a two-second statement limit, a 500 ms lock limit, and a five-second idle-transaction limit. Connection acquisition and client query waits are bounded at five seconds; each transaction contains several bounded statements, so these are not a single overall request deadline. The pool has four connections. Idle connection errors disable the adapter until restart; failed transactions discard their connection.

Results are limited to two candidate rows, 16 projected columns, and 128 KiB of JSON per row, configurable downward. Oversized payloads are replaced with a sentinel inside PostgreSQL and rejected before transferring them to Node. This bounds transferred output; the database may still need to scan or construct data within its statement deadline. Index the bound key/tenant columns. Capvine does not replace database resource controls or a query planner review.

`test/postgres.test.ts` starts a real private temporary PostgreSQL cluster through `pg_config`, `initdb`, and `pg_ctl`; it never uses an existing database. Tests cover projected reads, record/tenant/connection changes, SQL-like parameter values, write attempts before dispatch, broad roles, changed database/table identity, result bounds, lock timeouts, and recovery after query failure. PostgreSQL 14+ and a non-root test user are required. CI installs PostgreSQL and runs these tests; tests fail rather than silently skip when required binaries are missing.

PostgreSQL application records remain separate from the SQLite permission/lifecycle store. The combined configuration-file server is still in progress under [issue #3](https://github.com/farming-labs/capvine/issues/3).
