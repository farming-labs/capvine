# Workflow approval console

The workflow console gives a single authenticated owner a browser flow for approving configured permissions, provisioning separate workers, renewing their grants, and disabling an entire workflow. It uses the same saved approvals, delegation profile, HTTP verifier, worker assignments, and session/CSRF controls as the existing service and account console.

## Try a real local file

```sh
npm ci
npm run console:workflows
```

Open `http://127.0.0.1:8789/workflows`. The command prints a private state directory and the path to its `console.key`. Enter that key in the local sign-in form. The example registers a real text file containing generated sample report content. No external account is involved.

1. Review the displayed resource, operation, approval duration, and worker lifetime. Select **Approve**.
2. Select **Provision worker** under the saved approval. Each worker gets its own signing identity and assignment file.
3. Expand **Connect this worker to your runtime** and use the displayed MCP configuration. The example points to the built CLI with an absolute Node executable and script path, so it works before npm publication.
4. Call `read_report` in that runtime. It reads the registered file through the authority, not through direct file access in the worker.
5. Select **Disable workflow**, acknowledging that this stops all workers using that approval. Later calls fail and no new grants can be issued from that approval.

The process checks for grants nearing expiry every ten seconds and renews them from their existing approvals. It does not ask the owner again for each read or renewal. An expired or disabled approval requires a new approval. Closing the browser or signing out does not stop a previously approved workflow; closing the console process stops automatic renewal, and already issued grants retain their expiry.

The example retains its state on shutdown. Restart with the same directory and port to reuse the authority identity, coordinator key, approvals, and assignments:

```sh
npm run console:workflows -- --directory /absolute/path/from-first-run --port 8789
```

The resource service uses the next port, 8790 by default. Keep that endpoint stable because worker assignments pin it. This example runs under one OS user and is not a sandbox for hostile workers.

## Embed the manager and console

Start an existing configured resource service and create its protected administration client as described in [service administration](service.md). The following code runs in trusted application code:

```ts
import { openWorkflowManager } from "@farming-labs/capvine/workflows";
import { startWorkflowConsole } from "@farming-labs/capvine/workflow-console";

const workflows = await openWorkflowManager({
  directory: "/protected/workflow-assignments",
  ownerId: "configured-owner",
  coordinator: persistentCoordinatorIdentity,
  service: service.principal,
  url: service.url,
  administration: admin,
  workflows: [
    {
      id: "report",
      label: "Read the delivery report",
      resource: "urn:capvine:resource:report",
      action: "fs/read",
      toolName: "read_report",
      approvalSeconds: 3600,
      grantSeconds: 300,
      workerSeconds: 60,
    },
  ],
});

const consoleApp = await startWorkflowConsole({
  workflows,
  loginKey: protectedConsoleKey,
  port: 8789,
});
```

The console key is a random 32-byte base64url value. Keep it, the operator token, and the coordinator key in protected application configuration. The manager's `ownerId` must match the configured service owner. Use the existing private identity helpers to preserve the coordinator key across restart. Close the console first, then the workflow manager, then the resource service.

The `workflows` list is trusted configuration. IDs, labels, resource/action choices, and lifetimes are not inferred from a model prompt. The browser sends only a selected definition, approval, or worker ID. The manager selects the immutable stored permission and validates it before provisioning or renewal. A changed definition cannot retarget an existing approval; it is shown as unavailable for further provisioning and renewal, while the owner can still disable it. Existing issued grants follow their original scope until expiry or revocation.

This works with any registered repeatable-read adapter, including filesystem, PostgreSQL, GitHub, and Gmail. Register the intended resource and its handler in the authority first. The separate Gmail test screen's session-local selection is not automatically registered in this persistent service. A connector still holds provider credentials and enforces the actual provider target.

Pass `workflows` to `startAccountConsole` to show workflows alongside account connections under the same login. The owners must match. Both console entry points run the renewal loop; `openWorkflowManager` alone does not start background work. Applications can call `renewDue()` from their own trusted supervisor.

## Storage and lifecycle

The existing SQLite permission store holds approvals, their lifecycle tasks, issued roots, and revocations. `approval.list` is an authenticated operator command with an owner-filtered cursor and a maximum of 100 results; the console uses pages of 20. `ApprovalStore.listApprovals` is optional for custom stores. Existing integrations need it only when opting into listing or this console. Listings contain permission metadata, never account credentials or signing keys.

The workflow directory contains a fixed owner/coordinator/service/endpoint binding, one private assignment file per worker, and an exclusive manager lock. The manager refuses a different binding, an unbound directory containing existing assignments, or concurrent ownership. File custody and crash recovery follow the [worker guide](workers.md). Back up that directory with the coordinator identity and authority state. Do not restore authorization state to an earlier point without considering revived grants and approvals.

Each approval has its own task. Disabling it invalidates existing children and future issuance without enumerating descendants. Revoking a single parent is different: an active approval can authorize a fresh parent. Disabling does not cancel an already dispatched operation or erase returned data. The UI's unexpired status describes the stored grant's time; the authority makes the actual authorization decision on every invocation.

The manager serializes administration, bounds queued work, and supports up to 32 configured definitions and 32 assignment files. Expired/disabled assignments still count. After stopping the manager and confirming the corresponding approvals are disabled, a trusted operator can archive inactive assignment files outside this directory. Automatic archival and a large-scale job scheduler are not implemented. An unreadable assignment cannot renew; the UI keeps the saved approval's disable control available. Renewal errors are shown without replacing failed permissions with broader access.

The renewal loop considers grants with at most 30 seconds remaining. A cycle has a ten-second work budget checked between workers; an in-flight administrative request can finish after that budget. Grant expiry remains the fallback when the console, authority, or storage is unavailable. Persistent retries, distributed scheduling, and high availability require a separate design.

## Security boundary and verification

This is a local, single-owner console. It binds to loopback, checks Host and Origin, rotates login sessions, uses one-use CSRF tokens, rejects extra action fields, escapes labels, and never exposes broad service credentials or private signing keys in its pages. Keep the owner's browser, console login key, operator access, and provisioning storage outside the worker's reach. Do not publish or tunnel this console; use the [account console boundary](account-console.md) and [security model](../SECURITY.md).

`test/workflows.test.ts` drives the real HTTP login/forms against a persistent authority and registered file. It launches a separate MCP process, checks direct/MCP reads, automatic renewal without another approval, restart persistence, workflow disable, malformed assignments, owner/service/coordinator binding, changed configuration, pagination, escaping, and form replay/substitution. Raw signed worker escalation remains covered by `test/worker.test.ts` at the authority boundary. Browser verification covers approval, provisioning, displayed CLI configuration, a real file read followed by denial after disable, and desktop/mobile layout. These checks do not replace independent security review or production deployment validation.
