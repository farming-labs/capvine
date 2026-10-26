# Inspect recorded permissions

This API and CLI are available in the source checkout after `0.0.1`; they are not included in the published `0.0.1` package. They reuse the owner/administration authentication boundary and do not issue permissions or change verification.

## Run the walkthrough

With Node.js 24 and dependencies installed:

```sh
npm run example:inspection
```

The example creates a private temporary directory and a real report file. An owner issues a root grant to a coordinator, the coordinator delegates to a worker, and that worker reads the file over HTTP. The owner revokes the root, the service restarts, and the same child is denied. A separate CLI process then prints the recorded root's revoked status and the allowed/denied outcomes. It removes its temporary state when finished. No provider account is needed. This demonstrates enforcement and persistence, not OS isolation.

## Application API

Use the authenticated owner client from the [application guide](application.md):

```ts
const page = await client.grants.list({ limit: 25 });
const grant = await client.grants.get({ id: issued.id });
const outcomes = await client.audit.list({ limit: 25 });

if (page.nextCursor) {
  const next = await client.grants.list({ after: page.nextCursor, limit: 25 });
}
```

The backend equivalents are `app.api.grants.list({ headers, body })`, `app.api.grants.get({ headers, body: { id } })`, and `app.api.audit.list({ headers, body })`. Listing bodies are optional. These methods use the same verified owner session and same-origin checks as issuance. POST routes are `/api/capvine/grants/list`, `/api/capvine/grants/get`, and `/api/capvine/audit/list`. No caller-supplied owner ID is accepted. Worker signing identities and delegation proofs do not authenticate these routes.

Each grant contains:

| Field                           | Meaning                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `audience`                | Recorded root CID and the recipient of that root.                                                                                                        |
| `resource`, `action`, `service` | Exact registered resource, operation and receiving service. Older stored grants return `null` for action/service because those values were not recorded. |
| `expiresAt`, `expired`          | Expiry in Unix seconds and its comparison with the inspection clock.                                                                                     |
| `revoked`                       | Whether this root is recorded as revoked.                                                                                                                |
| `task`                          | Task ID and its stored `active` flag.                                                                                                                    |
| `workflow`                      | Associated saved approval ID, expiry in seconds, `expired` and `disabled` flags; otherwise `null`. Disable reflects task termination.                    |

These flags are independent. Revoking a root does not disable a saved workflow's future issuance. Workflow expiry stops renewal, while previously issued grants have their own expiry and task checks. A privileged administrator may also issue grants directly into a task. Inspection reports those records without claiming a grant is currently usable: account disconnection, removed plugins, provider failures or other checks can still prevent a call. Inspection does not open a resource or contact its provider.

## Running service and CLI

The existing administration client gains `listGrants({ after?, limit? })`, `readGrant(id)` and `listAudit({ after?, limit? })`. They use the service's protected administration endpoint. The older operator `audit()` method remains available.

For the CLI, create an owner-only JSON file (`0600`) with the running service's administration URL and absolute token-file path:

```json
{
  "url": "http://127.0.0.1:8791/admin",
  "tokenFile": "/private/capvine/admin.token",
  "limit": 25
}
```

```sh
npm run build
node dist/cli.js inspect /private/capvine/inspect.json grants
node dist/cli.js inspect /private/capvine/inspect.json audit
```

Set `after` in the private configuration to the previous page's `nextCursor` to continue that listing. Grant and audit cursors are different; do not interchange them. The CLI accepts HTTPS or loopback HTTP and reads the existing token from its protected file. It does not take a token on the command line or open the live database. The token still carries full operator authority; this is not a separate read-only operator credential. Keep both the file and CLI process outside worker access.

## Coverage and limits

- Lists default to 25 records, with a maximum of 100 per call. Grants sort by root ID; outcomes sort by timestamp and event ID. Cursors are positions, not permissions or stable snapshots. Concurrent writes or a backwards clock change can require restarting a listing. The service does not yet provide audit retention or a background export facility; operators must monitor disk usage.
- Outcomes contain event ID, `at` in Unix milliseconds, invocation CID when available, referenced root CID, outcome and a generic reason. `allowed` means authorization passed before dispatch, not that the handler completed. A handler exception adds a `failed` event. `denied` records rejection. No successful-completion event is currently written.
- Owner inspection includes only events associated with a known root whose resource and task both belong to that owner. A denied event's root association means the request referred to that root; it does not prove an authenticated caller used it. Malformed/unknown-root requests and legacy events without a root association remain outside this view. Operator audit may contain those events.
- Offline child delegations are not exhaustively registered. The inspector lists recorded roots and root-associated invocation outcomes, not every child, intermediate recipient or complete delegation tree. A child's CID cannot be looked up as a recorded root merely because it was invoked.
- Responses exclude raw proofs, signing material, provider credentials, resource targets and resource contents. Unknown stored reason strings become `other`; errors are not returned as provider messages. Metadata remains private to the owner/operator.
- Missing ownership, malformed returned state and storage errors fail rather than returning a fabricated empty or successful result. Inspection does not replace signature verification, lifecycle checks or worker isolation. Revocation cannot cancel an operation already dispatched or recall returned data.

For embedded backends, `createPermissionInspector({ store, owner })` is exported from the core entry. It is a trusted-code helper: authenticate the owner before selecting that parameter. `MemoryStore` and `SqliteStore` implement the additional `InspectionStore` query methods; the existing `StateStore` contract is unchanged. New grant/audit JSON fields are optional, so existing schema-1 SQLite records remain readable without inventing missing metadata.
