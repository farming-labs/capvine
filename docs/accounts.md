# Direct account connections

Capvine can connect to a provider directly, save encrypted credentials, and refresh access tokens in the trusted backend. Workers receive scoped grants; they do not receive OAuth credentials or the account manager. This is an optional layer alongside the generic verifier, filesystem, PostgreSQL, GitHub, and MCP integrations.

The implementation uses `oauth4webapi` for OAuth/OIDC processing. It includes a Google provider and a Gmail adapter for reading one registered message's subject and snippet. Other providers can implement the `AccountProvider` interface. The supplied `createOidcProvider` supports confidential authorization-code clients using S256 PKCE, RS256 ID tokens, a UserInfo endpoint, client-secret POST authentication, and refresh tokens. It is not an automatic adapter for every OAuth provider; Slack and GitHub account onboarding still need their own provider integration.

For an interactive browser flow, use the [account connection console](account-console.md): `npm run console:accounts -- --fixture`. It also supports protected Google configuration.

## Run the working example

```sh
npm ci
npm run example:accounts
```

Use Node.js 24+. The example starts a local OAuth/OIDC provider fixture, completes an actual HTTP authorization-code exchange, saves credentials encrypted, issues a saved workflow approval, and launches a separate worker. The first read refreshes an expiring token. Restart preserves the account and approval. Changed account identity and disabled grants reject. Temporary state and servers are cleaned up afterward.

No external account or credential is needed. This validates the protocol against a fixture, not live Google consent, Google's deployment requirements, or hostile-process containment.

## Connect Google from your backend

Register a web application with Google, enable the Gmail API, and configure its exact callback URI and consent screen. The provider requests `openid` and `gmail.readonly` with offline access. Gmail read access is a restricted scope with provider verification requirements. See [Google's web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server), [OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect), and [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes).

```ts
import { openAccountManager } from "@farming-labs/capvine/accounts";
import { createGoogleProvider } from "@farming-labs/capvine/oauth";

const accounts = await openAccountManager({
  directory: "/private/capvine-accounts",
  key: credentialEncryptionKey,
  providers: [
    createGoogleProvider({
      clientId: serverSecrets.googleClientId,
      clientSecret: serverSecrets.googleClientSecret,
      redirectUri: "https://app.example.com/accounts/google/callback",
    }),
  ],
});
```

`credentialEncryptionKey` is a persistent, randomly generated 32-byte key supplied by your protected secret manager. Do not generate a new key on each startup or store it in the database. The sample stores its temporary key in a private file; a production deployment owns key custody and recovery.

In your authenticated connection route:

```ts
const connection = await accounts.begin({
  ownerId: authenticatedSession.userId,
  sessionId: authenticatedSession.privateNonce,
  connectionId: crypto.randomUUID(),
  provider: "google",
});
// Redirect the owner's browser to connection.url.
```

In the callback route, using the same authenticated browser session:

```ts
const account = await accounts.complete({
  ownerId: authenticatedSession.userId,
  sessionId: authenticatedSession.privateNonce,
  callback: callbackUrl,
});
```

The owner and session are authenticated application values, never values trusted from a request body or model prompt. Use a cryptographically random session nonce of at least 32 characters and a protected browser session. Protect connection initiation against CSRF. Derive `callbackUrl` from your configured public origin and the incoming path/query; do not trust an arbitrary caller-supplied destination. The library checks the fixed callback origin/path, one-use state, session/owner binding, ten-minute expiry, PKCE, nonce, issuer, audience, ID-token signature, and provider subject. The account manager itself does not provide browser routes. The optional [local account console](account-console.md) supplies owner login, session/CSRF controls, HTTP callbacks, and connect/disconnect/reconnect screens; applications embedding the manager directly still own those controls.

After completion, use the returned subject and a message selected through owner-authorized setup:

```ts
import { createGmailAdapter } from "@farming-labs/capvine/gmail";

const adapter = createGmailAdapter({
  accounts,
  ownerId: authenticatedSession.userId,
  messages: [
    {
      id: "urn:capvine:resource:selected-message",
      connectionId: account.id,
      subject: account.subject!,
      messageId: selectedMessageId,
    },
  ],
});
```

Pass this adapter to `startResourceServer`. It uses action `gmail/message.read` with the existing [saved approval API](workflow-approvals.md). The adapter accepts multiple registered messages/connections through one operation. Resource selection stays in protected setup; the worker cannot select another account or message in its invocation.

The server verifies the capability first, obtains a usable credential, verifies the provider subject with that credential, and uses that same captured credential for the exact message read. It checks the returned message ID and projects bounded subject/snippet data. The account manager and provider/fetch implementations are trusted backend code. `withAccessToken` is an integration API for trusted handlers, not a worker tool or public endpoint.

## Storage, refresh, and disconnect

`accounts.db` stores account records and pending connection state using Node's AES-256-GCM with random nonces and authenticated record identifiers/revisions. The key stays outside SQLite. The credential directory must belong to the service user with mode `0700`; the database uses `0600`. Startup checks the key and schema and holds an exclusive lock. An incorrect key or unreadable/corrupt state fails closed. This protects a database copy without its key; it does not protect a compromised service process or host.

The credential database is separate from the authorization database containing grants, approvals, tasks, and revocations. Preserve both, the authority identity, and the encryption key as a consistent protected backup. Rollback can restore previously disabled accounts or permissions. Key rotation, historical backup invalidation, and automatic recovery after rollback require a separate operational design.

Calls to one connection are serialized within the manager. Before an access token expires, the manager refreshes it and persists any rotated refresh token before dispatch. An omitted replacement refresh token preserves the previous one. Scope loss and `invalid_grant` require reconnection. A failed write never falls back to dispatch with unpersisted credentials. If the provider rotates a token but the response or local write is lost, reconnect may be necessary; there is no distributed transaction with the provider.

```ts
const metadata = accounts.inspect(ownerId, connectionId);
accounts.disconnect(ownerId, connectionId);
await accounts.close();
```

Inspection returns safe identifiers/status/scopes, never tokens. Disconnect persists a tombstone and clears the current encrypted token record. In-flight refresh or connection completion cannot reactivate it. It blocks later dispatch; it cannot cancel a request already sent. Local disconnect does not revoke provider-side consent or erase historical backups; revoke access through the provider when required.

Connection IDs are never reused, including after a failed/expired flow. Reconnect with a new ID, register new resources, and make new approval decisions so an old grant cannot silently point at another account. Metadata and expired/consumed connection attempts have no automatic retention policy yet. `close()` drains admitted work before closing state. After a crash, verify the old process is stopped before manually removing its stale lock.

## How often does the owner authorize?

- Connect the provider initially. Normal access-token renewal then happens in trusted code. Provider revocation, expired refresh credentials, scope changes, or lost rotation state may require reconnecting.
- Approve each exact workflow through your application. Capvine can issue new short-lived grants from that saved approval without a human prompt on every run.
- Verify every worker call. This is automatic and remains necessary even while both the account connection and saved approval are valid.

The account manager is a single-process local implementation, not a multi-replica vault. Custom provider drivers must validate stable identity, permissions, token lifetimes, destinations, and responses. Production isolation, live Google consent/refresh, account-management UI, remote tenant administration, Slack onboarding, provider revocation APIs, full email bodies/attachments, and writes remain separate work. The package remains private pending external review.
