# Resource adapters

Adapters initialize protected connections and return `{ resources, operations, close }`, implementing `ResourceAdapter` from `./adapter`. They use the existing `Operation.execute(resource)` seam; they do not parse capability proofs or introduce another authorization path. `startResourceServer` composes initialized adapters with the persistent service and closes them after the service drains. Startup failures close all supplied adapters. Callers must clean up earlier adapters if a later adapter fails before composition.

Operation names and resource IDs must be unique across the configured adapters. The service refuses conflicting persistent resource bindings, duplicate operations/resources, and resources without a matching operation kind. An adapter must independently validate that the received resource matches its initialized binding before performing effects. Adapter implementations, configuration, and credentials are trusted code/data.

## Registered text files

```ts
import { createFilesystemAdapter } from "@farming-labs/capvine/filesystem";
import { startResourceServer } from "@farming-labs/capvine/adapter";

const files = await createFilesystemAdapter({
  root: "/private/application-data",
  connectionId: "application-files",
  ownerId: "owner-id",
  files: [{ id: "urn:capvine:resource:report", path: "reports/latest.txt" }],
});
const server = await startResourceServer({
  directory: "/private/capvine-state",
  owner: "owner-id",
  adapters: [files],
});
```

After ordinary authenticated administration issues an `fs/read` grant for that resource, the client calls `client.invoke(grant)` and receives UTF-8 text. The request has no path argument. Limits are 256 registered files and 128 KiB per read (configurable downward). Invalid UTF-8, oversized files, directories, missing files, symbolic links, and hard links fail closed. Reads allocate only the configured bound plus one byte and use independent offsets, so concurrent readers do not share a seek position.

### File identity and deployment boundary

Supported platforms are Linux and macOS, with ordinary local filesystems. The configured root and intermediate directories must belong to the service user and disallow group/other writes. The files must also belong to that user, have one link, and disallow group/other writes. Protect the root's ancestors from untrusted changes as part of deployment. Workers must run outside that OS identity and must not be able to write these directories or files. Network filesystems, hostile writers sharing the service UID, and untrusted mount management are outside this adapter's supported boundary.

The adapter rejects traversal components and symlinked path components, opens the final file with `O_NOFOLLOW`, checks the opened descriptor, and retains that descriptor. **Protection against a parent-directory swap during initialization relies on those directories being protected from untrusted writers.** Checking names alone would not establish that boundary. A deployment requiring hostile mutable ancestors needs an OS-enforced resolution mechanism such as a separately designed Linux `openat2` implementation.

Replacing the pathname after initialization does not retarget a running grant: reads continue from the original opened file. Removing its last link makes subsequent reads fail. In-place edits by the trusted application are visible; detected metadata changes during a read reject that read. This is not a filesystem snapshot or a transactional read guarantee.

The persisted binding includes the canonical root, relative path, device, inode, and birth timestamp. After restart, a replacement file conflicts with the old binding and cannot silently receive its grants. Operators must register a new resource ID after an intentional atomic replacement. This is local OS file identity, not a portable content identifier or protection against a malicious filesystem. Backups/restores must account for changed file identities.

`test/filesystem.test.ts` exercises real files, concurrent reads, link/traversal rejection, file replacement during service lifetime and across restart, content limits, UTF-8 rejection, HTTP grant invocation, and revocation. It does not claim containment of arbitrary code running as the service user.

## PostgreSQL

The PostgreSQL record adapter and combined configurable server are still in progress under [issue #3](https://github.com/farming-labs/capvine/issues/3). PostgreSQL application records are separate from the SQLite store used for Capvine's permissions and lifecycle state.
