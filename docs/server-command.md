# Run the resource server

The source checkout provides `npm run server -- …`. After `npm run build`, `node dist/cli.js …` runs the built command. The package is still private on npm; these commands do not assume a public release.

## Reproducible demonstration

```sh
npm ci --ignore-scripts
npm run check
npm run example:resources
```

Requires Node.js 24+, Linux/macOS, and PostgreSQL 14+ server binaries discoverable through `pg_config`, as a non-root user. The example creates its own temporary database cluster, protected file, state directory, and identities. It does not connect to or modify existing databases. Its database accepts local fixture connections only through a private Unix socket directory and never listens on TCP. Do not copy its fixture authentication into a production database.

The example launches the real server command and an ordinary client in separate processes. The client receives two child grants and reads the file and database record through the same `invoke` API. The example revokes the file's parent, restarts the authority, verifies the database grant still works, ends the task, restarts again, and verifies that the database grant now fails. CI runs this demonstration. Processes share a host user; this demonstrates the permission path, not hostile-code containment.

## Configure a deployment

Create a protected configuration directory with mode `0700` and save `server.json` with mode `0600`:

```json
{
  "directory": "state",
  "owner": "application-owner",
  "port": 8080,
  "administrationPort": 8081,
  "adapters": [
    {
      "type": "filesystem",
      "connectionId": "application-files",
      "root": "data",
      "files": [{ "id": "urn:capvine:resource:report", "path": "report.txt" }]
    },
    {
      "type": "postgres",
      "connectionId": "application-db",
      "databaseId": "application-db-identity",
      "connectionEnv": "CAPVINE_DATABASE_URL",
      "records": [
        {
          "id": "urn:capvine:resource:invoice42",
          "schema": "billing",
          "table": "invoices",
          "key": { "column": "id", "value": "42" },
          "tenant": { "column": "tenant_id", "value": "tenant-a" },
          "columns": ["id", "status", "total"]
        }
      ]
    }
  ]
}
```

Paths in JSON resolve relative to its directory. Configure one adapter per type, with unique connection names and resource IDs. Either adapter can be used alone. Unknown fields/types, embedded credential fields, malformed bindings, and duplicate registrations reject startup. The configuration file is bounded at 64 KiB and must be private, owned by the service user, and not a link. Protect its ancestor directories too.

Provision the [filesystem and database prerequisites](resources.md), including the logical database identity table and restricted reader role. Inject `CAPVINE_DATABASE_URL` into the authority process through your secret manager or protected service environment. Do not put it in JSON, command arguments, source control, worker configuration, or a model prompt. The command does not read `.env` files automatically. Credentials are only resolved in the protected process.

Initialize once, then serve:

```sh
npm run server -- init /private/capvine/state application-owner
npm run server -- serve /private/capvine/server.json
```

Initialization requires a new directory. Startup requires the existing identity/state pair; it does not reset keys, resources, revocations, or ended tasks. The first JSON output line reports the public service DID and listener URLs. It never reports the operator token or database credential. Startup failures deliberately use a generic error instead of printing database connection errors that could contain secrets.

Both listeners bind only to loopback. Keep administration private and use the [authenticated administration SDK](service.md) to issue grants. A trusted launcher gives each worker only its own signing identity, pinned authority DID/endpoint, and serialized grants. The operator token remains in `state/admin.token`; the worker does not receive it.

Use `SIGINT` or `SIGTERM` for graceful shutdown. Listeners stop admitting requests, pending work drains, and adapter resources close before the process exits. After an unclean exit, inspect process state before removing a stale service lock. Back up keys and state consistently and review restoration of revocations as described in the [service guide](service.md).

## Hosting boundary

This command is a single-authority local service, not a complete public deployment. Remote use requires a protected TLS proxy, separate OS identities or equivalent isolation for untrusted workers, network controls, monitoring, and tested recovery. Never give a worker a logged-in browser, broad filesystem mount, database password, administration token, or another route that bypasses the authority.

Programmatic applications can use `loadConfiguration`/`startConfiguredService` from `./configuration`, `startResourceServer` from `./adapter`, or the lower-level authority directly. Those APIs keep the general-purpose application/service integration; no LLM, MCP client, or agent harness is required.
