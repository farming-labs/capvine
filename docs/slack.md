# Slack account connections and message reads

The `./slack` entry adds `createSlackProvider` and `createSlackAdapter`. It reuses the encrypted account manager, exact resource grants, saved approvals, worker provisioning, and MCP bridge. No provider token is passed to a worker.

This integration has an HTTP provider fixture and a separate-process example. Live Slack consent, app settings, workspace restrictions, rate limits, and revocation have not been validated with a real workspace. The `0.0.1` release is experimental; live Slack acceptance remains open.

## Run the example

```sh
npm ci
npm run example:slack
```

The example exchanges a code with PKCE against the local fixture, stores rotating user credentials encrypted, approves one Slack message, and provisions a worker. Direct and separate-process MCP calls read the same message. The example also checks token refresh, credential exclusion from the worker file, parent revocation, service/account restart, renewal from the saved approval, provider revocation, and disabling further grants. Temporary data is removed at exit.

The fixture returns generated text. It does not connect to a Slack workspace or establish OS containment.

## Account provider

Create a dedicated Slack test app and configure its callback, user history scopes, PKCE, and token rotation. This driver uses the public-client PKCE flow without a client secret. Slack documents that enabling PKCE changes the app's client type and cannot be undone without contacting support; do not change an existing production app just to run the example. See [Slack's PKCE setup](https://docs.slack.dev/authentication/using-pkce/).

```ts
import { openAccountManager } from "@farming-labs/capvine/accounts";
import { createSlackProvider } from "@farming-labs/capvine/slack";

const accounts = await openAccountManager({
  directory: "/private/capvine-accounts",
  key: persistentEncryptionKey,
  providers: [
    createSlackProvider({
      clientId: configuredSlackClientId,
      appId: configuredSlackAppId,
      redirectUri: "https://app.example.com/accounts/slack/callback",
      scopes: ["channels:history"],
    }),
  ],
});
```

Supply a persistent 32-byte encryption key through protected application setup. The client ID and app ID identify the configured Slack app. `fetch`, when supplied, is trusted backend infrastructure, not a caller-controlled transport.

Use the existing owner/session-bound `accounts.begin` and `accounts.complete` flow described in [direct accounts](accounts.md). Authenticate the owner and protect the start route against CSRF. The callback must be exactly the configured origin and path. State is single-use and bound to the initiating session; the code verifier stays in encrypted pending state.

Slack's [OAuth v2 response](https://docs.slack.dev/reference/methods/oauth.v2.access/) places user credentials under `authed_user` on initial exchange; a refresh returns credentials at the top level. This driver validates both shapes and requires rotating user tokens, the configured app, a workspace installation, and exactly the requested scopes. Allowed scopes are `channels:history`, `groups:history`, `im:history`, and `mpim:history`. Choose only those the selected resources need. Extra scopes from an earlier broader installation are rejected too.

Slack is not treated as an OIDC provider here: there is no ID-token/nonce step. The driver verifies the credential with [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/) after exchange, on refresh, and before a read. It binds the connection subject to `slack:<team_id>:<user_id>` and rejects a different workspace, user, or bot identity. Display names and workspace URLs are not identity keys.

The generic [account console API](account-console.md) can be configured with provider ID `slack`, a label, and authorization origin `https://slack.com`. Its runnable Google example and Gmail selection screen are not a Slack browser application. For a deployed HTTPS callback use authenticated application routes; validate any local callback with Slack's requirements before relying on the loopback console.

## Register one message

After the owner connects and selects the exact conversation and message through trusted setup:

```ts
import { createSlackAdapter } from "@farming-labs/capvine/slack";

const adapter = createSlackAdapter({
  accounts,
  ownerId: authenticatedOwnerId,
  messages: [
    {
      id: "urn:capvine:resource:approved-slack-report",
      connectionId: connectedAccount.id,
      subject: connectedAccount.subject!,
      channelId: selectedConversationId,
      timestamp: selectedMessageTimestamp,
    },
  ],
});
```

Pass the adapter to `startResourceServer` alongside other adapters. Issue or approve action `slack/message.read` for that resource using the existing [approval API](workflow-approvals.md). Then [provision a worker](workers.md) or use the normal signed client invocation. A workflow console definition can use that same action/resource and tool name `read_slack_report`.

The worker does not supply a workspace, connection, channel, timestamp, method, or destination URL. After verification, the adapter calls the fixed Slack `conversations.history` endpoint with the registered channel and timestamp, inclusive boundaries, and limit one. It requires exactly one result with that timestamp and returns only:

```ts
{
  (channelId, timestamp, text);
}
```

Text is limited to 16,384 JavaScript characters; the full provider response is bounded to 128 KiB with a ten-second request timeout. Redirects are not followed. Blocks, attachments, files, profile data, and linked resources are not returned or fetched. Thread traversal and writes are not implemented. See Slack's [single-message history guidance and API limits](https://docs.slack.dev/reference/methods/conversations.history/).

## Lifecycle and limits

The account manager serializes use of one connection, refreshes before access-token expiry, and persists each replacement refresh token before dispatch. This driver requires every rotation to return a refresh token and an access-token lifetime of at most 24 hours. See [Slack token rotation](https://docs.slack.dev/authentication/using-token-rotation/). If rotation succeeds but its response or local write is lost, reconnect may be necessary.

Explicit credential rejection during refresh or `auth.test` clears the stored credentials and persists `reconnect_required`. This is a conservative response to rejected access, not proof of why Slack rejected it. HTTP 429/5xx and other temporary errors block the read without discarding credentials. There is no automatic retry loop; applications must respect provider limits. Message endpoint failures block that read and are not reinterpreted as account revocation.

Local disconnect does not uninstall the Slack app or revoke provider consent. Reconnect creates a fresh connection ID; old resources and approvals do not retarget. Revoking a Capvine parent grant blocks its descendants while other valid roots can remain usable. Disabling the saved approval also stops further issuance for that workflow.

Bot credentials, organization-wide installations, GovSlack, automatic channel discovery, message writes, and provider revocation/uninstall APIs are outside this implementation. Credential custody, authenticated resource selection, network isolation, and production operations remain application responsibilities.

## Live validation gate

Use a dedicated app/workspace and a non-sensitive test message. Verify initial consent, stable workspace/user identity, a delegated read of the selected message, access-token rotation, process restart, provider revocation, and reconnect with a new resource/approval. Confirm that the old worker remains denied, provider throttling does not trigger retry storms, and no provider token reaches the worker or logs. Record results without real message content or credentials. Fixture results do not close this gate.
