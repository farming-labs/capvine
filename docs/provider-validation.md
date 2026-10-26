# Validate a real provider connection

`npm run provider:check` exercises an already connected Google or Slack account through the existing adapters and a separate MCP worker. It does not obtain consent or revoke provider access. Use a dedicated test account/app and one non-sensitive message selected by its owner.

Stop the console or other process holding the account directory before running this command. It uses the same encrypted credential database and can refresh credentials or persist `reconnect_required`; do not copy a live database or delete its lock to bypass exclusive ownership. Restart the console afterward with its original configuration.

Save this configuration outside the checkout in a private directory, with mode `0600`. Use the same provider configuration and encryption key as the original connection. The connection ID and stable subject come from trusted account inspection; they are not an email address or a model-selected account name.

```json
{
  "directory": "/private/capvine/accounts",
  "encryptionKeyFile": "/private/capvine/encryption.key",
  "ownerId": "application-owner",
  "connectionId": "existing-connection-id",
  "subject": "existing-stable-subject",
  "provider": {
    "type": "google",
    "clientIdFile": "/private/capvine/google-client-id",
    "clientSecretFile": "/private/capvine/google-client-secret",
    "redirectUri": "http://127.0.0.1:8787/oauth/callback"
  },
  "message": { "messageId": "selected-message-id" }
}
```

For Slack, replace the provider and message objects:

```json
{
  "provider": {
    "type": "slack",
    "clientId": "123.456",
    "appId": "AEXAMPLE",
    "redirectUri": "http://localhost:8787/oauth/callback",
    "scopes": ["channels:history"]
  },
  "message": {
    "channelId": "CEXAMPLE",
    "timestamp": "1700000000.000042"
  }
}
```

The callback must exactly match the one used when connecting. These are illustrative values, not a ready-to-connect Slack console. Complete Slack onboarding using authenticated application routes and the [Slack integration guide](slack.md). Never change an existing app's PKCE settings merely to run a test.

## Read, restart, and local revocation

```sh
npm run provider:check -- read /private/capvine/provider-check.json
```

The command creates temporary authority/worker identities and one saved approval, then checks:

1. A separate stdio MCP worker reads the selected message.
2. A raw signed request for an unassigned resource is denied by the server.
3. The same worker can read after account-manager and authority restart.
4. Revoking the parent blocks that worker.
5. Disabling the approval prevents further root issuance.

Only boolean results and successful refresh/verification counts are printed. Message content, account identifiers, credentials, and proofs are not printed. Temporary authority state is removed; the original account database remains. This is an operator validation command, not an endpoint or a sandbox. The test worker shares the host user and is trusted test code.

A zero refresh count means rotation was not exercised. Repeat after normal access-token expiry to observe refresh; do not edit the credential database to force it. An error must remain a failed result, not a skipped provider check.

## Provider rejection and reconnection

First establish a successful read. Then revoke the dedicated test app's access through the provider's account-management UI. Google documents that revocation can affect this user's grants for every client under the same project; establish that the project is dedicated or obtain consent for that wider effect before doing it. See [Google's revocation behavior](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

After revocation has propagated, with the console stopped:

```sh
npm run provider:check -- expect-rejected /private/capvine/provider-check.json
```

This probes credential verification without reading a message. It requires credential use to fail, status to become `reconnect_required`, and that status to survive reopening the account store. A temporary provider outage, a wrong account, or local disconnect does not pass. `newlyObservedRejection: false` means the connection was already marked for reconnection; it is persistence evidence, not a fresh observation of provider revocation. A rejection does not establish why the provider rejected the token.

Reconnect through the authenticated application. Record the new connection ID, explicitly select the resource again, and rerun the read check with a new private configuration. Verify the old connection still fails with its original configuration. Existing production grants must not be retargeted to the new connection. To close the full live lifecycle gate, also retain an actual old worker in the host application and show its signed call stays denied after reconnect; this temporary read command removes its own workers when it exits.

## Retain a worker across reconnection

Source after `0.0.1` includes `provider:lifecycle` for the old-worker/new-worker part of the check. It works against a running application or service using existing private assignments from `provisionWorker` or the workflow manager. It does not connect accounts, revoke provider consent, mint permissions or replace the provider-rejection check above.

Before revocation, provision a dedicated read-only test worker for the selected message. Use a lifetime sufficient for the test within the owner's approved limit. Its assignment directory and the parent of the new capture directory must be owned by the operator with mode `0700`; assignment files must be `0600`. Then run:

```sh
npm run provider:lifecycle -- capture /private/workers/original.json /private/review/retained-worker
```

Capture makes a private copy at `retained-worker/worker.json`, invokes that exact copy, discards the returned content, and records a digest only after a successful read. It refuses an existing capture directory and removes a new incomplete capture if the check fails. This copy contains the worker's signing key and proof: keep it outside source control and worker/model access. Leave the snapshot unchanged even if the application's original assignment renews later.

Next perform and record the provider-side revocation, persistent `reconnect_required` observation and fresh consent described above. Select a new resource bound to the new connection and explicitly approve/provision a new worker. Keep the old resource binding, task and grant in place; do not locally revoke them or disable their workflow merely to make the test pass. Otherwise the result would not isolate reconnection behavior.

```sh
npm run provider:lifecycle -- compare /private/review/retained-worker /private/workers/fresh.json
```

Comparison requires the retained assignment's digest to match, both proofs to remain unexpired, the same exact endpoint/service/action, and different worker and resource identities. It invokes the fresh worker and requires success, then invokes the retained worker and requires HTTP 403 through the existing transport. It rechecks expiry and file integrity afterward. HTTP 500/503, timeout, connection failure, changed files, an expired proof, a changed service or an old worker that still succeeds all fail the check. Confirm persistent reconnect-required state before comparing; a first provider rejection may surface as a generic handler error, which this comparison deliberately does not count as a denial.

Restart the actual application/service without changing its endpoint or identity and repeat `compare` with the same files. Keep both redacted outputs alongside the provider observations and source revision in the acceptance record. If a proof expires (or has 15 seconds or less remaining), start a new capture and repeat the lifecycle; expiration is not evidence of provider revocation. Delete the private capture and disposable assignments after recording results.

This tool proves only the observed reads and denial. A 403 alone cannot establish its cause: local revocation, task disable, a removed plugin or ingress policy could also deny access. The receipt is operator-controlled local evidence, not a signature, tamper-evident log or independent attestation. The tool does not establish provider identity, fresh consent, refresh behavior or OS isolation. Those observations and a reviewer/operator's assessment remain separate requirements. HTTPS is required except for explicitly local development using loopback HTTP; both assignments must use the same endpoint.

The automated Google and Slack tests run the full application over HTTP with simulated providers and separate CLI processes, including fresh connections and retained-worker denial after restart:

```sh
node --import tsx --test test/provider-lifecycle.test.ts
```

These are fixture tests. They do not access a real Google account or Slack workspace and do not close either live-provider gate.

Record the source revision, date, provider, dedicated test setup, pass/fail checks, whether refresh actually occurred, and provider-specific restrictions. Keep private identifiers out of public evidence. Fixture tests for this runner live in `test/provider-validation.test.ts`; they do not establish live-provider behavior.
