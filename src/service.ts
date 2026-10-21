import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isDeepStrictEqual } from "node:util";
import { createAuthority } from "./server.ts";
import { SqliteStore } from "./sqlite.ts";
import { createHttpHandler } from "./http.ts";
import { createAdministrationHandler } from "./administration.ts";
import { createWorkflowApprovals } from "./approvals.ts";
import {
  assertPrivateDirectory,
  initializeIdentity,
  loadIdentity,
  readPrivateFile,
  writePrivateFile,
} from "./identity-file.ts";
import { PermissionDenied, type Operation, type Resource } from "./types.ts";
import { respond } from "./http-internal.ts";

export async function initializeService(
  directory: string,
  owner: string,
): Promise<string> {
  if (!owner.trim()) throw new Error("Owner is required");
  await mkdir(directory, { mode: 0o700 });
  await assertPrivateDirectory(directory);
  const signer = await initializeIdentity(join(directory, "authority.key"));
  await writePrivateFile(
    join(directory, "admin.token"),
    randomBytes(32).toString("base64url"),
  );
  await writePrivateFile(join(directory, "state.db"), "");
  const store = new SqliteStore(join(directory, "state.db"));
  try {
    store.bindService(signer.did(), owner);
  } finally {
    store.close();
  }
  return signer.did();
}

async function listen(server: Server, port: number): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listening address");
  return `http://127.0.0.1:${address.port}`;
}

export async function startService(options: {
  directory: string;
  owner: string;
  resources: Resource[];
  operations: Operation[];
  port?: number;
  administrationPort?: number;
}) {
  await assertPrivateDirectory(options.directory);
  const lockPath = join(options.directory, "service.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let store: SqliteStore | undefined;
  const servers: Server[] = [];
  const pending = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      await Promise.all(
        servers.map(async (server) => {
          server.closeIdleConnections();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => server.closeAllConnections(), 5000);
            timer.unref();
            server.close(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }),
      );
      await Promise.allSettled([...pending]);
      try {
        store?.close();
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    })());
  const track =
    (
      handler: (
        request: IncomingMessage,
        response: ServerResponse,
      ) => Promise<void>,
    ) =>
    (request: IncomingMessage, response: ServerResponse) => {
      if (closed) {
        request.resume();
        respond(response, 503, { error: "closing" });
        return;
      }
      const job = handler(request, response);
      pending.add(job);
      void job.then(
        () => pending.delete(job),
        () => {
          pending.delete(job);
          response.destroy();
        },
      );
    };
  try {
    await lock.writeFile(String(process.pid));
    const signer = await loadIdentity(join(options.directory, "authority.key"));
    const token = await readPrivateFile(join(options.directory, "admin.token"));
    const database = join(options.directory, "state.db");
    const info = await lstat(database);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("Invalid database ownership, type, or mode");
    const check = await open(
      database,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    await check.close();
    store = new SqliteStore(database);
    store.bindService(signer.did(), options.owner);
    const resources = structuredClone(options.resources);
    const seen = new Set<string>();
    const authority = createAuthority({
      signer,
      store,
      authorizeGrant: ({ actor, resource, task }) =>
        seen.has(resource.id) &&
        actor === options.owner &&
        actor === resource.ownerId &&
        actor === task.ownerId,
    });
    for (const operation of options.operations) {
      const execute = operation.execute;
      authority.registerOperation({
        ...operation,
        execute: (resource) => {
          if (!seen.has(resource.id))
            throw new PermissionDenied("Resource is not configured");
          return execute(resource);
        },
      });
    }
    for (const resource of resources) {
      if (
        resource.ownerId !== options.owner ||
        seen.has(resource.id) ||
        !options.operations.some(
          (operation) => operation.resourceKind === resource.kind,
        )
      )
        throw new Error("Invalid or duplicate configured resource");
      seen.add(resource.id);
      const existing = store.getResource(resource.id);
      if (existing && !isDeepStrictEqual(existing, resource))
        throw new Error(
          "Configured resource conflicts with persistent binding",
        );
    }
    for (const resource of resources)
      if (!store.getResource(resource.id)) store.addResource(resource);
    const invocation = createServer(
      { headersTimeout: 5000, requestTimeout: 10_000 },
      track(
        createHttpHandler({
          execute: async (bytes) => {
            if (closed) throw new Error("Service is closing");
            return authority.execute(bytes);
          },
        }),
      ),
    );
    const administration = createServer(
      { headersTimeout: 5000, requestTimeout: 10_000 },
      track(
        createAdministrationHandler({
          authority,
          store,
          owner: options.owner,
          token,
          audit: () => store!.audit(100),
          approvals: createWorkflowApprovals({
            authority,
            store,
            owner: options.owner,
          }),
        }),
      ),
    );
    servers.push(invocation, administration);
    const url = `${await listen(invocation, options.port ?? 0)}/invoke`;
    const administrationUrl = `${await listen(administration, options.administrationPort ?? 0)}/admin`;
    return { principal: authority.principal, url, administrationUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}
