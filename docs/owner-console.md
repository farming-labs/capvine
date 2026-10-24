# Resource selection and workflow approval

`createOwnerConsole` mounts an optional same-origin owner interface on top of the application API. It uses your application's verified login session; it does not add a second login system or give workers an owner session.

```ts
import { createOwnerConsole } from "@farming-labs/capvine/owner-console";

const console = createOwnerConsole({
  app: capvine,
  baseURL: "https://app.example.com",
  path: "/capvine",
  providers: [{ id: "google", label: "Google" }],
  plugins: [
    {
      id: "gmail",
      label: "Gmail messages",
      type: "gmail.message",
      provider: "google",
    },
    { id: "reports", label: "Reports", type: "fs.file" },
  ],
  recipients: [{ label: "Report worker", audience: provisionedWorkerDID }],
});

async function handler(request: Request) {
  return (await console(request)) ?? capvine.handler(request);
}
```

Mount this handler alongside your existing login and application routes. Provider/plugin IDs must match `createCapvine` configuration. Recipient identities come from your trusted worker provisioning process. The console configuration is a display catalog, not an additional authorization policy: the authenticated owner can still use the underlying API to approve other valid recipients. Workers cannot use these owner endpoints.

Every page and asset authenticates through the application. Responses disable caching and framing; executable assets are restricted to a fixed allowlist. Provider subjects, filenames, resource targets and labels render as text. The interface has labeled controls, pending/error/empty states, pagination, keyboard focus, and a narrow-screen layout. It does not show provider credentials or worker private keys.

The sequence is:

1. Connect an account using the existing session-bound OAuth callback.
2. Browse selectable resources and select one. Discovery does not register resources or issue permission. Selection registers an exact immutable resource but still grants no authority.
3. Review the resource, action, recipient and approval duration. Explicit approval stores the workflow.
4. Your host application's protected assignment channel uses `client.workflows.issue` or `maintain` to deliver grants. The console does not distribute proofs or run workers in the owner browser.
5. Disable the workflow to block its existing grants, descendants and renewal. Disconnecting an account blocks access through its old connection; reconnecting requires a fresh selection and approval.

## Plugin discovery

The same operation is available without the console:

```ts
const page = await client.resources.discover({
  plugin: "gmail",
  connectionId: selectedConnection.id,
});
// page.items: [{ label, target }], page.nextCursor: string | null
```

Gmail lists ten messages per page with bounded subject metadata. No bodies or provider tokens are returned. This is a privileged owner read, separate from a worker's granted read. Filesystem discovery lists regular files immediately inside the configured root; directories and symbolic links are omitted. It examines at most 4096 directory entries and returns at most 25 choices per page. File identity and path confinement are checked again at registration and invocation; a listing is not authority.

Other plugins can supply a bounded catalog or provider-specific discovery:

```ts
const messages = definePlugin({
  ...slackMessages(),
  discover: () => ({
    items: [
      {
        label: "Approved support message",
        target: { channelId: "CEXAMPLE", timestamp: "1700000000.000042" },
      },
    ],
    nextCursor: null,
  }),
});
```

`discover({ ownerId, accounts, connectionId?, after? })` is trusted backend code. Return at most 25 choices with a nonempty label (256 characters maximum), an exact target, and a bounded opaque cursor or `null`. Do not return secrets or arbitrary provider response objects. Validate provider identity, scopes, fixed origins, response sizes and timeouts in custom discovery. Capvine authenticates the owner before calling it, verifies any selected connection belongs to that owner, and projects only labels/targets/cursors in the response. `open` remains responsible for binding the actual resource.

Slack and PostgreSQL do not automatically enumerate channels or tables. Supply a catalog or a discovery implementation for your application's supported objects. This avoids silently requiring wider provider scopes or unrestricted database queries. No discovery endpoint is exposed to workers.

## Run the complete local screen

```sh
npm run console:application
```

Open the printed loopback URL, choose **Open demo workspace**, connect **Demo mail**, select a message or file, approve a workflow, and disable it. The demo uses disposable files and a simulated provider, clearly labeled on its entry screen. Its convenience login is only for those fixtures; it must never be connected to real accounts. Closing the process removes its temporary state. The production-facing console uses the existing application authenticator shown above.

The runnable UI tests the owner workflow. Separate-process delegation and renewal are exercised by `npm run example:application`; fixture UI behavior, live Google behavior, host containment, and independent review are distinct evidence.
