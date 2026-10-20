# Security model

Capvine is an experimental prototype. It has not been independently audited and is not ready to guard bank transfers or other irreversible actions.

## Intended boundary

The adversary may control a worker, ignore the SDK, sign arbitrary requests with that worker's own key, modify a requested resource or operation, and attempt to reuse a proof. The protected authority must reject requests outside the worker's valid delegation chain before calling the registered handler.

The authority process, its signing key, state store, owner authorization callback, operation implementations, and provider connectors are trusted. Workers must not be able to modify those components, read another worker's keys, or directly use broad provider credentials.

The repository tests explicit negative cases: changed resources, operations, tasks, services, identities, signatures, expiry expansion, missing proofs, unknown roots, revocation, task termination, malformed archives, and excessive delegation depth. Tests are evidence for these behaviors, not a general security guarantee.

## Integration requirements

- Authenticate the owner before calling `issue`; the `actor` string is not authentication.
- Keep registration, grant issuance, task administration, and revocation operations on a separately authorized application surface.
- Store provider credentials and private keys outside agent-accessible files, tools, browsers, logs, and prompts.
- Preserve the service identity and state store together across restarts.
- Bind each handler's actual target to the verified server resource. Do not authorize one target and then execute an unchecked argument.
- Apply transport authentication where appropriate, TLS, rate limits, body limits, and operational monitoring in the hosting application. There is no built-in HTTP server yet.
- Treat operation handlers and their dependencies as trusted code. Capvine does not sandbox them.

## Current limitations

- The example uses in-process fixture data, not a live provider integration or an isolated worker.
- Requests are repeatable. There is no replay ledger, single-use consumption, atomic budget accounting, or provider idempotency integration. Use only repeatable reads for this prototype.
- Read-only handler behavior is an application responsibility; the library cannot prove that a callback has no external effects.
- Revocation stops subsequent authorization. It does not cancel in-flight operations or erase returned data.
- A permitted read can still disclose sensitive information to its recipient. Capvine does not enforce information-flow restrictions on returned data.
- A valid capability does not make model output correct, remove prompt injection, or protect an unrestricted browser, shell, operating system, or network path.
- Shared agent identities do not provide per-agent isolation. The runtime must keep worker keys and task bindings separate.
- Offline child delegations are not exhaustively indexed. Root grants and authorization outcomes are persisted; a comprehensive grant explorer is future work.
- SQLite storage and audit logs are trusted local state, not encrypted or tamper-evident storage.

## Reporting

Use GitHub's private vulnerability reporting for this repository when available. Avoid public issues containing credentials or exploit details for deployments using this prototype. For ordinary non-sensitive bugs, open an issue with a minimal reproduction.
