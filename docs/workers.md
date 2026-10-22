# Provisioned workers

The `./worker` entry connects saved approvals to ordinary jobs and MCP runtimes. A trusted application provisions a private assignment file. A separate worker reads it and invokes only its assigned resource through the existing HTTP verifier. There is no runtime-specific harness or provider credential in the assignment.

## Approve once, provision each worker

The owner-facing application first authenticates the owner and approves an exact workflow using [saved approvals](workflow-approvals.md). The following code runs in the trusted backend, which owns the administration client and coordinator key. It is not a browser or worker API.

```ts
import { provisionWorker, renewWorker } from "@farming-labs/capvine/worker";

const parent = await admin.issueApproved("daily-report");
const assignment = await provisionWorker({
  path: "/protected/assignments/report.json",
  coordinator: coordinatorIdentity,
  grant: parent,
  url: service.url,
  toolName: "read_report",
  expiresAt: new Date(Date.now() + 60_000),
});
```

Provisioning creates a new signing identity and delegates to it. The file contains that worker's private key, one child proof with its embedded chain, the coordinator's public identity, a fixed invocation URL, and a tool name. It contains no operator token, provider credential, or coordinator private key. The returned description contains public identifiers and expiry, never the private key. The path is chosen by protected application code; an existing assignment is never overwritten by provisioning.

One assignment represents one exact resource/action/task/service binding and one worker. To give independent workers access, provision separate files with separate keys. To grant a different resource or action, obtain a separate owner-authorized grant. A worker can delegate its existing capability using the core client API; this helper does not impose a new depth limit or alter the existing capability profile.

## Run a separate worker

After building, start the installed CLI as a stdio MCP server:

```sh
capvine worker /protected/assignments/report.json
```

A compatible runtime can launch this process using its MCP configuration:

```json
{
  "mcpServers": {
    "report": {
      "command": "capvine",
      "args": ["worker", "/protected/assignments/report.json"]
    }
  }
}
```

The server advertises the configured tool, accepts no tool arguments, and writes only MCP messages to stdout. The package is still private; use the checked-out source command `node --import tsx src/cli.ts worker /absolute/path/report.json` until publication is approved.

Ordinary application workers use the same assignment directly:

```ts
import { loadWorker } from "@farming-labs/capvine/worker";

const worker = await loadWorker("/protected/assignments/report.json");
const report = await worker.invoke();
```

Both paths sign requests with the worker's own key. The protected authority verifies the full proof chain and current lifecycle state before dispatching to the adapter. A local assignment-file check is not proof of authorization.

## Renew without asking again

While the saved approval remains active, trusted application code can request a fresh parent and replace the worker's child proof:

```ts
await renewWorker({
  path: "/protected/assignments/report.json",
  coordinator: coordinatorIdentity,
  grant: await admin.issueApproved("daily-report"),
  expiresAt: new Date(Date.now() + 60_000),
});
```

The worker retains its key. Resource, action, task, service, coordinator, endpoint, and tool name cannot change through this API. Child expiry cannot exceed the new parent's expiry. Both a running MCP server and a previously loaded direct worker reload the assignment on their next call. Missing, malformed, or changed assignments fail closed; they never fall back to an older proof. An already-started read may finish under the proof it loaded before replacement.

The backend chooses when to renew. These APIs do not install a scheduler, select an approval from a model prompt, or authenticate the owner. Bind a job to its saved approval in trusted application code. Do not expose `issueApproved` with arbitrary model-selected IDs or give the worker the operator token.

Revoking one parent stops that branch. An active saved approval can still authorize a fresh root. **Disable the saved approval** to stop existing descendants and further issuance for the whole workflow. Renewing a local file with an old revoked proof cannot restore access: the server still checks revocation and task state on every call.

## Files, persistence, and deployment

Assignment paths must be absolute. The containing directory must be owned by the current OS user with mode 0700; files must be private, owned, regular, single-link files. Loading refuses symbolic links and files over 64 KiB. Renewal serializes writers with an exclusive adjacent `.lock` file, writes and syncs a private temporary file, then atomically renames it and syncs the directory. Readers see the old or new complete assignment. A reported I/O failure after rename can leave the new assignment installed; inspect the file before retrying.

A crashed renewal can leave a lock or temporary file. Stop and verify all writers before removing a stale lock; never automatically remove it because of its age. Preserve the coordinator key, worker assignment, service identity, and permission state across restart. Assignment files contain private signing keys and must not be committed or logged.

The directory and its ancestor paths are trusted provisioning storage. These file checks do not isolate hostile processes sharing the same user. In a container deployment, make only that worker's assignment directory available read-only and keep authority, coordinator, operator, provider, and other-worker files outside its namespace. Match the assignment's numeric UID to the worker runtime. Mount the directory, not an individual file inode, if workers must observe atomic renewals. Provisioning is not a sandbox; see [the deployment boundary](../SECURITY.md).

## Verification

`npm run example:mcp` registers a real text file, saves an approval, and launches the production CLI in a separate stdio process. Direct and MCP calls return the same file. The example verifies parent revocation, service restart with a persistent coordinator/approval, fresh issuance without another owner approval, renewal in the still-running worker, and workflow disable blocking both calls and issuance.

`test/worker.test.ts` covers private files, unchanged worker identity, renewal restrictions, malformed/substituted assignments, and raw signed escalation attempts through HTTP that bypass the SDK. `test/mcp.test.ts` checks that a dynamic proof loader cannot retarget an existing tool and that load failures do not fall back to an old grant. The reference example shares an OS user; it establishes process and authorization behavior, not hostile-code containment. The [workflow console](workflow-console.md) connects owner approvals to this provisioning API and automatically renews eligible workers.
