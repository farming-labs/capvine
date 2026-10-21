# Executor integration

The optional `./executor` entry connects Capvine's verified resource dispatch to a companion app running in Executor. It supports exact reads of a Gmail message's subject and snippet. It does not expose Executor's general tool catalog, generated code execution, account administration, or provider credentials to workers.

Tested combination: Executor **2.0.0-beta.25**, companion framework **apps@0.0.1-beta.95**, and the MCP `call` tool over Streamable HTTP. The 1.x CLI is not supported. Pin these versions; the beta protocol and runtime may change.

## Run the real Executor demonstration

Install the executable in a separate local directory, without installing a background service:

```sh
npm install --ignore-scripts --include=optional --prefix /tmp/capvine-executor-runtime executor@2.0.0-beta.25
CAPVINE_EXECUTOR_BIN=/tmp/capvine-executor-runtime/node_modules/.bin/executor npm run example:executor
```

Node.js 24+ and a supported Executor platform are required. The example starts its own temporary Executor instance and credentialed mailbox fixture, deploys the companion reader, and saves an account through Executor's account-connection API. The actual Executor runtime performs the HTTP provider read. The fixture is not Gmail and does not exercise Google OAuth consent or refresh.

The example checks successful reads, persisted accounts after Executor restart, account relinking, replacement credentials under the same account ID, and Capvine revocation. Both substitutions must fail before a message request reaches the fixture provider. It removes its own temporary data and stops its processes when finished. CI runs this scenario against the real pinned executable.

## Connect a real Gmail account

The production companion source is `examples/executor/app/`. Its provider requests `openid` and `gmail.readonly`, uses fixed Google endpoints, and asks for offline access. The latter Gmail scope is restricted; follow Google's verification and data-use requirements for the application you deploy. The fixture run is not evidence of completed provider verification or production onboarding.

1. Run your protected Executor instance at the pinned version. Configure its OAuth client and callback through Executor's account UI as required. Keep its data and encryption keys out of worker mounts.
2. Use `executor apps create --name "Capvine Gmail" --files examples/executor/app`, then `executor apps deploy --app <app-id> --files examples/executor/app`, with the host authentication configured only for the operator.
3. Open that app's Accounts tab and connect Google through its `gmail` requirement. Complete consent in the browser; never put provider tokens in Capvine resources or model prompts.
4. From trusted setup code, call the app's `inspectAccount` tool through Executor to obtain the current Executor account ID and verified Google subject. Select a Gmail message ID through an owner-authorized flow. Do not infer either identity from a friendly account label.
5. Provision `createExecutorGmailAdapter` with those identifiers and the app's actual slug. Keep the Executor access token in protected server configuration.

```ts
import { createExecutorGmailAdapter } from "@farming-labs/capvine/executor";

const adapter = await createExecutorGmailAdapter({
  url: "http://127.0.0.1:4312/mcp",
  token: serverSecrets.executorAccessToken,
  app: "capvine-gmail",
  connectionId: "work-mail",
  ownerId: authenticatedOwner.id,
  messages: [
    {
      id: "urn:capvine:resource:selected-message",
      accountId: verifiedAccount.accountId,
      subject: verifiedAccount.subject,
      messageId: selectedMessageId,
    },
  ],
});
```

The secret store, authenticated owner, and selection variables above are application-owned values. Supply the adapter to `startResourceServer`; the existing grant API uses action `gmail/message.read`. Workers invoke the resulting grant normally. The adapter keeps an immutable copy of each registration and rejects replacement bindings. Multiple mailbox accounts need separately configured adapters/apps because Executor resolves account links for each app.

## Enforcement and limitations

Capvine verifies the proof chain and lifecycle before calling Executor. The companion checks the account ID from its actual call context, captures that context's credential, checks its Google subject, and uses the same captured credential to read the exact message. A separate account preflight followed by an independently resolved call would introduce a substitution race; this app keeps both operations in one call. Credential renewal for the same provider identity remains valid; changed identities reject.

Provider reads reject redirects, enforce deadlines and response bounds, validate the returned message ID, and project only the subject/snippet. The adapter accepts only a completed successful result with matching identity and resource fields. Paused approvals, provider failures, malformed results, and unknown states fail closed; the adapter never automatically approves or resumes Executor work. The companion declares its reads runnable without an additional Executor prompt, so Capvine's grant remains the worker-facing authority check.

The authority, adapter, Executor runtime, app source/deployment, and account configuration are trusted code. Protect all of them from worker edits. Workers must have neither the Executor API token nor another authenticated route to its tools. HTTPS is required off loopback; transport redirects are refused. The demo shares a host user and is not a hostile-code sandbox. The existing container reference check does not establish isolation of this new deployment.

This adapter accepts an operator-provided access token; it does not implement an OAuth client for Capvine-to-Executor authentication. Provider token renewal belongs to Executor. Account onboarding through real Google consent, multi-tenant hosted Executor, full message bodies, attachments, writes, and production isolation require additional validation. The package remains private and independently unreviewed.

References: [Executor accounts](https://executor.sh/docs/connect-an-account), [app authoring](https://executor.sh/docs/author-an-app), [MCP calls](https://executor.sh/docs/mcp), and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
