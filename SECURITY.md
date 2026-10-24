# Security model

Capvine is an experimental prototype for repeatable reads. It has not been independently audited and is not ready to authorize irreversible operations.

## Intended boundary

The adversary may control a client, ignore the SDK, sign arbitrary requests with that client's own key, modify a requested resource or operation, and attempt to reuse a proof. The protected authority must reject requests outside the client's valid delegation chain before calling the registered handler.

The authority process, its signing key, state store, owner authorization callback, operation implementations, and provider connectors are trusted. Workers must not be able to modify those components, read another worker's keys, or directly use broad provider credentials.

The repository tests explicit negative cases: changed resources, operations, tasks, services, identities, signatures, expiry expansion, missing proofs, unknown roots, revocation, task termination, malformed archives, and excessive delegation depth. HTTP tests also cover size limits, redirect refusal, error redaction, and concurrency backpressure. The network scenario exercises separately signed worker requests across processes. The [container reference check](examples/isolation/README.md) also tests credential mounts, read-only filesystems, and disabled worker networking in Linux CI; its precise boundary is documented separately. Tests are evidence for these behaviors, not a general security guarantee.

## Integration requirements

`createCapvine` is trusted backend composition. Provider/resource plugins are explicit imports with the backend's privileges; they are not sandboxed. Setup never grants permission merely because a workflow is configured. Its default credential-encryption key is a private file outside the account database, so encryption protects a database copy without that key, not a complete state-folder copy or a compromised process. An externally supplied key remains the application's responsibility. See [plugin setup and key custody](docs/plugins.md).

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
- Network-demo administration uses private parent-process IPC. The persistent service adds separate loopback administration authenticated by a random operator token, bound to one configured owner. The optional account console adds a separate single-owner loopback browser login; multi-tenant and remote administration remain unsupported. The optional encrypted account store is an experimental local implementation. See [service deployment constraints](docs/service.md).
- The HTTP handler rejects requests with an Origin header; it is intended for server runtimes, not browser sessions. This header check is not client authentication: signatures and proof validation authenticate invocations.
- The HTTP handler admits at most 16 requests concurrently per handler instance. Request-body reading times out after five seconds, but handlers need their own execution deadlines. Client disconnects/timeouts do not cancel an already dispatched operation. There are no automatic retries.
- Requests are repeatable. There is no replay ledger, single-use consumption, atomic budget accounting, or provider idempotency integration. Use only repeatable reads for this prototype.
- The filesystem adapter requires protected local directories and a separate service OS identity. It pins opened files, but it is not safe against hostile directory writers sharing that identity. See [file identity and supported deployment](docs/resources.md).
- Read-only handler behavior is an application responsibility; the library cannot prove that a callback has no external effects.
- Saved approvals are privileged owner decisions, not model classifications. Renewal takes the fixed recipient and scope from stored policy; disabling ends the shared task and blocks dependent grants. The operator token can still authorize different workflows.
- The [account console](docs/account-console.md) uses a distinct random owner key, in-memory expiring sessions, session rotation, CSRF tokens, exact Origin/Host checks, and session-bound OAuth callbacks. It is loopback HTTP only, with no Secure cookie; do not tunnel or publicly expose it. Isolate its browser profile and OS user from workers. A same-host malicious process is outside this boundary. Reconnecting creates a new connection ID and never retargets existing resources.
- The direct account manager, encryption key, OAuth provider configuration, and credentialed handlers are trusted. Account records are encrypted separately from authorization state; workers must not access either store or key. The fixture exercises OAuth exchange and refresh but does not establish live Google consent/refresh or deployment containment; see [direct accounts](docs/accounts.md).
- The Slack driver accepts rotating workspace user tokens through PKCE and verifies the app, workspace/user binding, and exact configured read scopes. Its message adapter fixes the channel/timestamp at registration, uses a fixed Slack endpoint, rejects mismatched or excess results, and projects bounded text. Its HTTP fixture does not establish live Slack behavior, workspace policy, or production isolation; see [Slack integration](docs/slack.md).
- Revocation stops subsequent authorization. It does not cancel in-flight operations or erase returned data.
- A permitted read can still disclose sensitive information to its recipient. Capvine does not enforce information-flow restrictions on returned data.
- A valid capability does not make model output correct, remove prompt injection, or protect an unrestricted browser, shell, operating system, or network path.
- The MCP bridge trusts launcher provisioning and serves one worker/task per instance. It provides no public HTTP session authentication; anyone controlling its channel can use its assigned grants.
- Worker assignment files contain the worker's own private key and scoped proof. Provisioning storage and its ancestor paths are trusted. Atomic file renewal preserves the original binding for a running client; it does not sandbox the worker or make shared-UID files safe against hostile code. Keep other assignments and privileged credentials outside the worker's filesystem namespace. See [worker deployment constraints](docs/workers.md).
- The [workflow console](docs/workflow-console.md) uses the owner console's login and form checks. Its manager, configured workflow choices, operator client, coordinator identity, and renewal loop are trusted application code. A signed-in owner can approve those configured permissions and provision workers. Model classification is not owner approval; isolate this console from agent-controlled browsers. Logging out does not disable previously saved approvals, and closing the process does not revoke already-issued grants.
- Shared client identities do not provide per-client isolation. The application must keep client keys and task bindings separate.
- Offline child delegations are not exhaustively indexed. Root grants and authorization outcomes are persisted; a comprehensive grant explorer is future work.
- SQLite storage and audit logs are trusted local state, not encrypted or tamper-evident storage.

## Reporting

Use GitHub's private vulnerability reporting for this repository when available. Avoid public issues containing credentials or exploit details for deployments using this prototype. For ordinary non-sensitive bugs, open an issue with a minimal reproduction.

## Application handler and runtime registration

The application API accepts a trusted `authenticate(Request)` integration; it must verify the real login session and return its owner and individual session ID. Request-supplied owner IDs, worker proofs, and model decisions cannot replace that integration. Owner operations enforce the configured owner, exact same-origin mutation requests, and a custom request header; OAuth callbacks bind to the authenticated login session and stored state. The worker invocation route always uses signed capability verification. `capvine.api` calls share the HTTP handler's checks.

Runtime plugins are privileged adapters. Registrations are immutable and persist alongside permission state; configuration changes and replaced file identities cannot silently redirect old grants. Missing or disconnected accounts reject dependent requests. The new API does not add multi-tenancy, automatic permission renewal, write/replay semantics, a production owner UI, or provider consent revocation. The session in the executable example is only a fixture. Follow [the application guide](docs/application.md) for limits, state custody and host responsibilities.
