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

Record the source revision, date, provider, dedicated test setup, pass/fail checks, whether refresh actually occurred, and provider-specific restrictions. Keep private identifiers out of public evidence. Fixture tests for this runner live in `test/provider-validation.test.ts`; they do not establish live-provider behavior.
