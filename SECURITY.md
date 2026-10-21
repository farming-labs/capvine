# Security model

Capvine is an experimental prototype for repeatable reads. It has not been independently audited and is not ready to authorize irreversible operations.

## Intended boundary

The adversary may control a client, ignore the SDK, sign arbitrary requests with that client's own key, modify a requested resource or operation, and attempt to reuse a proof. The protected authority must reject requests outside the client's valid delegation chain before calling the registered handler.

The authority process, its signing key, state store, owner authorization callback, operation implementations, and provider connectors are trusted. Workers must not be able to modify those components, read another worker's keys, or directly use broad provider credentials.

The repository tests explicit negative cases: changed resources, operations, tasks, services, identities, signatures, expiry expansion, missing proofs, unknown roots, revocation, task termination, malformed archives, and excessive delegation depth. HTTP tests also cover size limits, redirect refusal, error redaction, and concurrency backpressure. The network scenario exercises separately signed worker requests across processes. The [container reference check](examples/isolation/README.md) also tests credential mounts, read-only filesystems, and disabled worker networking in Linux CI; its precise boundary is documented separately. Tests are evidence for these behaviors, not a general security guarantee.

## Integration requirements

- Authenticate the owner before calling `issue`; the `actor` string is not authentication.
- Keep registration, grant issuance, task administration, and revocation operations on a separately authorized application surface.
- Store authority keys and provider credentials outside client-accessible files, tools, browsers, logs, and prompts. Each client may hold its own signing key; it must not obtain another client's key.
- Preserve the service identity and state store together across restarts.
- Bind each handler's actual target to the verified server resource. Do not authorize one target and then execute an unchecked argument.
- Apply TLS, network admission controls, rate limits, execution deadlines, and monitoring in the hosting application. The Node HTTP adapter bounds requests/results and admitted concurrency; it is not a complete internet-facing deployment.
- Configure the client with the expected service identity and endpoint through trusted provisioning. The transport requires HTTPS except on loopback and refuses redirects; it does not authenticate owner administration or discover service trust.
- Treat operation handlers and their dependencies as trusted code. Capvine does not sandbox them.

## Current limitations

- The delegation and network examples use simulated provider data; the optional GitHub example reads a real public issue. The network example has real HTTP and separate processes but runs under one OS user; it does not demonstrate hostile-code containment.
- Network-demo administration uses private parent-process IPC. The persistent service adds separate loopback administration authenticated by a random operator token, bound to one configured owner. There is no browser login, multi-tenant administration, or production credential store. See [service deployment constraints](docs/service.md).
- The HTTP handler rejects requests with an Origin header; it is intended for server runtimes, not browser sessions. This header check is not client authentication: signatures and proof validation authenticate invocations.
- The HTTP handler admits at most 16 requests concurrently per handler instance. Request-body reading times out after five seconds, but handlers need their own execution deadlines. Client disconnects/timeouts do not cancel an already dispatched operation. There are no automatic retries.
- Requests are repeatable. There is no replay ledger, single-use consumption, atomic budget accounting, or provider idempotency integration. Use only repeatable reads for this prototype.
- The filesystem adapter requires protected local directories and a separate service OS identity. It pins opened files, but it is not safe against hostile directory writers sharing that identity. See [file identity and supported deployment](docs/resources.md).
- Read-only handler behavior is an application responsibility; the library cannot prove that a callback has no external effects.
- Revocation stops subsequent authorization. It does not cancel in-flight operations or erase returned data.
- A permitted read can still disclose sensitive information to its recipient. Capvine does not enforce information-flow restrictions on returned data.
- A valid capability does not make model output correct, remove prompt injection, or protect an unrestricted browser, shell, operating system, or network path.
- The MCP bridge trusts launcher provisioning and serves one worker/task per instance. It provides no public HTTP session authentication; anyone controlling its channel can use its assigned grants.
- Shared client identities do not provide per-client isolation. The application must keep client keys and task bindings separate.
- Offline child delegations are not exhaustively indexed. Root grants and authorization outcomes are persisted; a comprehensive grant explorer is future work.
- SQLite storage and audit logs are trusted local state, not encrypted or tamper-evident storage.

## Reporting

Use GitHub's private vulnerability reporting for this repository when available. Avoid public issues containing credentials or exploit details for deployments using this prototype. For ordinary non-sensitive bugs, open an issue with a minimal reproduction.
