# Deployment and recovery validation

The first deployment candidate is a single authority on Linux with isolated workers. This is a validation plan and runbook, not a claim that a production host has been approved. The existing container example runs a synthetic provider; the service command and account consoles bind to loopback. A macOS desktop controlled through accessibility, a logged-in browser, or shell access needs a separate boundary assessment.

## Trust and access paths

```text
Owner / protected operator setup
              |
      private administration
              v
Authority + immutable bindings + SQLite + protected provider credentials
              ^                                  |
      signed invocation                       provider API
              |
 Isolated worker: own key + scoped proof
```

The worker must not be able to read authority/account state, encryption keys, operator tokens, host control sockets, logged-in browser profiles, or another worker's identity. It must not be able to modify the authority executable/configuration or obtain credentials through a proxy. File modes alone do not isolate processes with the same OS identity.

The [container reference](../examples/isolation/README.md) enforces a networkless worker, read-only provisioning, distinct UIDs, dropped capabilities, no-new-privileges, and a Unix invocation socket. Its authority persists permission state separately. Run on a disposable Linux Docker host:

```sh
sh examples/isolation/run.sh
```

The script creates and deletes its own project volumes. It tests allowed reads, raw scope escalation, inaccessible credentials/state, filesystem tampering, network bypass, restart, and persistent revocation. It is a test fixture, not the production service launcher; do not put real credentials in it. The pinned Node digest must be updated through reviewed changes with this check rerun.

For a real application, choose an invocation transport and worker launcher that preserve those restrictions. The configuration-file server currently provides loopback HTTP, not the fixture's Unix socket. Do not bridge host networking into a worker simply to make the demo commands connect. Validate that actual route with the same negative checks before supporting it.

## Remote ingress

Keep administration and both owner consoles private. A remote invocation ingress needs trusted TLS termination, certificate renewal, an admission policy, and an exact route to `POST /invoke`. Do not forward arbitrary paths, `/admin`, or console routes. Bound request bodies, connection counts, and timeouts; disable proxy retries of operation requests. Redact authorization headers, bodies, and provider errors from logs. Signed requests still require complete server verification after TLS termination.

Validate from outside the host that unknown paths/methods reject, administration is inaccessible, unsigned/oversized requests fail before dispatch, TLS hostname/certificate validation works, and a valid granted invocation succeeds. Test through the intended firewall and proxy, not only loopback. No public domain, certificate, ingress, or private-provider egress policy is provisioned by the examples.

## Recovery drill

```sh
npm run example:recovery
```

This creates temporary files and real persistent services. It proves:

- A cold backup taken after revocation restores the same authority and retains parent revocation and workflow disable.
- An isolated backup taken before revocation can accept that old grant again. This expected result demonstrates why an old backup is unsafe to return to service automatically.
- A new authority/state pair rejects an old signed proof at the server and requires a new approval and a newly pinned grant.
- Rotating the operator token while stopped rejects the old token without invalidating existing worker grants.
- Concurrent ownership and a mismatched identity/database reject startup.

For production recovery:

1. Close external admission and stop/drain all authority and account-manager processes. Confirm they are stopped before treating a lock as stale. Do not automatically delete locks on startup.
2. Take or restore a consistent protected set: authority identity, permission database, operator configuration, account database and its encryption key, and immutable resource configuration. Store backup copies encrypted off-host with separately controlled access and retention. The example's temporary plaintext copies are not a production backup system.
3. Rehearse restoration with no worker admission. Check identity/state binding, schema compatibility, resource bindings, provider credential rotation state, and the revocation/task/approval history since the backup.
4. If complete lifecycle changes can be reconciled from an independently protected source, apply and test them before reopening. The existing bounded invocation audit is not that complete source.
5. If revocation continuity is uncertain, retain the old backup for investigation and initialize a new authority/state pair. Do not replace a key inside the old database. Re-register resources, obtain new approvals, repin trusted clients, and issue new grants. Disable the old endpoint. Old approvals and workers are not silently migrated.
6. Account rollback can restore locally disconnected connections or obsolete rotating refresh tokens. Do not blindly restore account access along with a new authority. Reconcile provider consent independently or reconnect fresh accounts and explicitly bind the new connection IDs.
7. Verify allowed and denied calls from actual workers before reopening admission. Record recovery time, data-loss window, operator identity, evidence, and any remaining uncertainty.

## Monitoring and host acceptance

Monitor process health, filesystem capacity, backup age/restore results, clock synchronization, TLS expiry, storage/audit failures, denied invocations, provider rejection/throttling, and reconnect-required accounts. Configure bounded log retention; never log returned resource contents, raw proofs, account tokens, or signing keys. Alert delivery and the operator response need a real host test. A present socket or a green process check alone is not evidence that an invocation can complete safely.

Record the exact source revision and image digest, host/kernel/runtime versions, network/mount/UID configuration, proxy settings, secret custody, backup destination, and responsible operator. Attach observed results for each access-path, ingress, recovery, and monitoring check to the release review. CI evidence covers the reference fixture and local application behavior; production-host, off-host recovery, real TLS, and macOS computer-use checks remain open until executed.
