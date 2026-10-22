# Account connection console

The optional `./account-console` entry provides a runnable, single-owner browser application around the direct account manager. It supports owner login, account listings, OAuth callbacks, disconnect, reconnect, and an optional Gmail delegation screen. Provider credentials remain in the backend. Connecting an account does not issue a capability or register a resource; those remain separate owner-authorized operations.

## Try the complete flow locally

```sh
npm ci
npm run console:accounts -- --fixture
```

Requires Node.js 24+ and an available port 8787. Open the printed URL. Read the access key from the printed `loginKeyFile` locally and enter it in the sign-in form. The program prints the file path, never the key. This temporary key only controls the local fixture.

Choose **Continue to provider**. The local OAuth/OIDC provider immediately authorizes its test account, returns a code to the console, and the backend exchanges it and saves encrypted credentials. Open **Manage connection** to inspect its identity and permissions, disconnect it, or reconnect with a new ID. Sign out to invalidate the browser session. Stop the process with Ctrl+C to close the servers and remove temporary fixture data.

The fixture makes no request to Google and does not connect a real account. Automated HTTP tests also exercise restarts, denied requests, and session boundaries. `npm run example:accounts` remains the separate demonstration of credential refresh, saved workflow approvals, and delegated reads.

## Configure a real Google account

1. In your Google project, enable the Gmail API and configure the OAuth consent screen and permitted test users. Create an OAuth **web application** client. Register exactly `http://127.0.0.1:8787/oauth/callback` as an authorized redirect URI. Use the corresponding port if you change it.
2. Create a private configuration directory outside the repository and worker-accessible paths. Give it mode `0700`. Store the Google client ID and client secret in separate regular files with mode `0600`, owned by the console's OS user. Do not put credentials in URLs, source control, or chat.
3. Generate two independent 32-byte random values, encoded as base64url: one persistent encryption key and one console login key. Store each in its own private `0600` file. Keep the encryption key across restarts; changing it makes the existing account database unreadable. The console key can be changed while stopped; restart invalidates old sessions. This example creates new files and refuses to overwrite existing ones:

```sh
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const directory = join(homedir(), '.capvine-console');
await mkdir(directory, { mode: 0o700 });
for (const name of ['encryption.key', 'console.key']) {
  await writeFile(join(directory, name), randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
}
JS
```

4. Save a private `0600` configuration file with absolute paths. Replace the sample paths and owner identity with your setup. The account database directory is created with mode `0700` if absent; its parent must already exist.

```json
{
  "port": 8787,
  "ownerId": "local-owner",
  "directory": "/absolute/private/accounts",
  "encryptionKeyFile": "/absolute/private/encryption.key",
  "loginKeyFile": "/absolute/private/console.key",
  "googleClientIdFile": "/absolute/private/google-client-id",
  "googleClientSecretFile": "/absolute/private/google-client-secret"
}
```

5. Run `npm run console:accounts -- --config /absolute/private/config.json`. Sign in with the console key, then connect Google through its consent screen. The requested scopes are `openid` and `gmail.readonly`. Provider consent is broader than a Capvine grant: only your registered messages become available to a worker.
6. Verify the connection, restart the console, and verify it remains listed. Open **Test Gmail delegation** beside the connected account to select an email and exercise a real delegated read. For application integration, register a selected message using the returned connection ID and subject in the [Gmail adapter](accounts.md). Use the same account-manager instance when the console and resource server run together; the store deliberately prevents concurrent managers opening the same directory. If running separately, stop the console before opening that store in the resource backend.
7. Verify a real delegated read after access-token expiry and after provider consent revocation. Refresh happens when a trusted handler uses the account, not when the console displays a listing. A list entry alone does not prove the provider still accepts the credentials. A refresh rejection changes the status to **Reconnect required** when the backend attempts that use. Reconnect requires registering a fresh connection ID; existing bindings are never rewritten automatically.

Google's [web-server OAuth instructions](https://developers.google.com/identity/protocols/oauth2/web-server) describe registration and offline access. Gmail read access is a [restricted scope](https://developers.google.com/workspace/gmail/api/auth/scopes); provider verification requirements and refresh-token lifetime restrictions depend on the app's publishing/testing status. Live Google consent, refresh, and provider-revocation behavior must be validated with a configured application; local fixture results do not establish them.

## Test a Gmail delegation in the browser

The runnable console enables this screen for both `--config` and `--fixture`. Embedded consoles opt in with `gmail: { source: "google" }`. The fixture launcher uses its local provider and explicitly labels the screen **Local provider fixture**; the Google configuration labels it **Live Google / Gmail** and calls the real Gmail API. This feature does not change the Google OAuth scopes or connect an account automatically.

1. Sign in and open **Test Gmail delegation** beside a connected Google account.
2. **Load recent email IDs** makes one owner-authorized list request, limited to five inbox IDs. It does not retrieve message content. Select an ID from the returned list. The backend checks ownership and binds that exact ID to the selected connection and Google subject.
3. **Approve this email** issues a read grant to the coordinator for at most ten minutes, capped by the console session's remaining lifetime.
4. **Delegate to worker** creates a child grant with the same scope and at most five minutes remaining. **Read selected email** invokes the signed grant through the verifier and Gmail adapter, then shows the actual message ID, subject, and snippet.
5. **Change resource**, **Try delete action**, **Try another worker**, and **Try expired request** send raw signed attempts through the same verifier. Each must be denied with zero additional Gmail message requests. A delete handler is never registered; the test cannot send a delete request to Gmail.
6. **Revoke parent**, then read again. The child must fail. **End task** blocks subsequent calls for that task. **Choose another email** invalidates the old run before starting another selection.

The run records provider-message request counts and actual authorization outcomes. Owner message discovery and OAuth refresh calls are separate from those counts. An unexpected outcome is shown as a failed boundary check, not a successful test. Message content is escaped as text and kept only in session memory. It remains visible across forbidden-request tests and is cleared before the next read attempt, revocation, task termination, selection replacement, sign-out, session cleanup, or process shutdown. The preview is labeled as the last successful read and does not imply a denied request fetched new data. Revocation does not erase data already returned to a reader or cancel a request already dispatched.

This console drives distinct signing identities inside the same trusted backend process. It does not launch an untrusted worker, isolate the OS, or provision a remote MCP session. The browser never receives signing keys, serialized grants, or provider credentials. The owner login, exact-origin checks, one-use CSRF tokens, bounded inputs, and session binding apply to every action. Requests cannot select unlisted messages, choose another session's run, expand the action, supply a target URL, or select another owner's account. Demo grants and selections are ephemeral; reconnect or restart requires a new selection and approval, while saved Google credentials persist.

Run `npm test` for the browser HTTP integration checks against the local OAuth provider. They cover real signed authorization, allowed reads, raw denials before provider access, parent revocation, task termination, session substitution, sign-out during discovery, escaped provider text, disconnect, and restart. Real Google tests require the configured web client and an enabled Gmail API. A local live smoke check has verified consent, refresh, delegated reads, persistence, parent revocation, and workflow disabling; provider-consent revocation and production isolation remain separate checks.

## Embed in an existing backend

```ts
import { startAccountConsole } from "@farming-labs/capvine/account-console";

const consoleApp = await startAccountConsole({
  accounts, // The same trusted AccountManager used by your adapters.
  ownerId: "local-owner",
  loginKey: protectedConsoleKey, // 32 random bytes encoded as base64url.
  port: 8787,
  gmail: { source: "google" }, // Optional owner-driven Gmail delegation test.
  providers: [
    {
      id: "google",
      label: "Google / Gmail",
      authorizationOrigin: "https://accounts.google.com",
    },
  ],
});
```

Configure the provider's redirect URI as `http://127.0.0.1:8787/oauth/callback` before opening the manager. The provider list is server configuration, not caller input. The console verifies the authorization redirect's origin against this list. Custom providers must implement `AccountProvider`; the UI does not add Slack or GitHub OAuth drivers automatically. `consoleApp.close()` drains HTTP work and clears browser sessions; it does not close the shared account manager. Close the console and resource server before closing the manager.

`accounts.list(ownerId, { after, limit })` returns safe metadata and `nextCursor`, with up to 100 records scanned per page (25 by default). It filters by owner before returning metadata. A page can be empty while having a continuation cursor when other owners occupy that part of the store. Follow cursors until null. This is a trusted backend API, not an authenticated HTTP endpoint on its own.

## Browser boundary and limitations

The console binds only to `127.0.0.1` and checks the exact Host header. It ignores forwarded headers. It is not a remote administration server and must not be exposed through a public tunnel or reverse proxy. Its loopback HTTP cookies deliberately omit `Secure`; a future remote version requires a separate HTTPS/session/deployment design. Another local process or an agent-controlled browser profile can access loopback cookies or the console; isolate this owner browser and OS identity from workers. Loopback is not protection against a compromised host.

The access key is a random operator credential, not a human password, and is distinct from Capvine's service administration token and the encryption key. Authenticated sessions expire after 30 minutes, unauthenticated login sessions after five minutes. Session state stays in memory, so logout, key rotation with restart, and process restart invalidate it. Login rotates the session identifier. The console bounds concurrent requests, session count, form bodies, and failed login attempts.

All forms require the exact Origin header and a session-bound, one-use CSRF token; stale tabs must reload after another form submission. OAuth callbacks instead require the initiating authenticated session and the account manager's one-use state/PKCE/OIDC checks. A callback after sign-out, session expiry, or restart requires starting a new connection. Provider errors redirect to a fixed, sanitized status message and do not echo codes or credentials. Pages prohibit scripts, framing, and arbitrary form destinations. Referrers are restricted to the same origin on forms and suppressed on callback responses, avoiding null-Origin form submissions. These controls follow the [OWASP session](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) guidance; independent review remains open.

Disconnect clears the locally usable credentials and preserves the connection ID as a tombstone. It does not revoke provider consent, erase backups, cancel an already dispatched operation, or revoke unrelated grants. Reconnect disconnects the old record first and creates a new record even if the provider flow fails or the owner chooses another account. This prevents old resource bindings from silently switching identities.

The [workflow console](workflow-console.md) provides reusable approvals and external worker provisioning; pass its manager as `workflows` to combine both views. Multi-user login, remote administration, credential-key rotation, and production deployment remain separate work. The Gmail screen is a session-bound owner test, not a complete hosted application.
