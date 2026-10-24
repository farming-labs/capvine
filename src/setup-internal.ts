import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  openAccountManager,
  type AccountProvider,
  type AccountManager,
} from "./accounts.ts";
import { startResourceServer, type ResourceAdapter } from "./adapter.ts";
import { createAdministrationClient } from "./administration.ts";
import { initializeService } from "./service.ts";
import { openAccountDatabase } from "./account-store.ts";
import {
  assertPrivateDirectory,
  initializeIdentity,
  loadIdentity,
  readPrivateFile,
  writePrivateFile,
} from "./identity-file.ts";
import { openWorkflowManager, type WorkflowDefinition } from "./workflows.ts";
import { validateWorkflowDefinitions } from "./workflow-definition.ts";
import {
  defineResource,
  type ResourcePlugin,
  type ResourceContext,
} from "./resources.ts";
import { PermissionDenied, type Operation, type Resource } from "./types.ts";

export interface ResourceSetup {
  resources: ResourcePlugin[];
  workflows?: WorkflowDefinition[];
}

export interface CapvineOptions {
  directory: string;
  ownerId: string;
  providers?: AccountProvider[];
  encryptionKey?: Uint8Array;
  resources?: ResourcePlugin[];
  workflows?: WorkflowDefinition[];
  port?: number;
  administrationPort?: number;
  workerCommand?: { command: string; args: string[] };
}

export function workflow(
  options: Pick<WorkflowDefinition, "id" | "resource" | "action"> &
    Partial<Omit<WorkflowDefinition, "id" | "resource" | "action">>,
): WorkflowDefinition {
  const result = {
    label: options.id,
    toolName: options.id.replaceAll("-", "_"),
    approvalSeconds: 3600,
    grantSeconds: 300,
    workerSeconds: 120,
    ...options,
  };
  validateWorkflowDefinitions([result]);
  return Object.freeze(result);
}

function configuration(input: ResourceSetup) {
  if (
    Object.keys(input).some((key) => !["resources", "workflows"].includes(key))
  )
    throw new Error("Unknown resource setup option");
  if (
    !Array.isArray(input.resources) ||
    !input.resources.length ||
    input.resources.length > 32
  )
    throw new Error("Configure between 1 and 32 resource plugins");
  const resources = input.resources.map(defineResource);
  const workflows = structuredClone(input.workflows ?? []);
  validateWorkflowDefinitions(workflows);
  return { resources, workflows };
}

async function compose(
  plugins: ResourcePlugin[],
  context: ResourceContext,
  workflows: WorkflowDefinition[],
): Promise<ResourceAdapter> {
  const adapters: ResourceAdapter[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      for (const adapter of [...adapters].reverse()) {
        try {
          await adapter.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Resource plugin cleanup failed");
    })());
  try {
    for (const plugin of plugins) adapters.push(await plugin.open(context));
    const resources: Resource[] = [];
    const ids = new Set<string>();
    const groups = new Map<
      string,
      { kind: string; handlers: Map<string, Operation["execute"]> }
    >();
    for (const adapter of adapters) {
      if (
        new Set(adapter.operations.map((op) => op.action)).size !==
        adapter.operations.length
      )
        throw new Error("Resource plugin declares duplicate operations");
      for (const resource of adapter.resources) {
        if (ids.has(resource.id) || resource.ownerId !== context.ownerId)
          throw new Error(
            "Resource plugins must declare unique IDs owned by the configured owner",
          );
        ids.add(resource.id);
        resources.push(structuredClone(resource));
      }
      for (const operation of adapter.operations) {
        let group = groups.get(operation.action);
        if (group && group.kind !== operation.resourceKind)
          throw new Error("An operation cannot span different resource kinds");
        if (!group) {
          group = { kind: operation.resourceKind, handlers: new Map() };
          groups.set(operation.action, group);
        }
        for (const resource of adapter.resources.filter(
          (r) => r.kind === operation.resourceKind,
        ))
          group.handlers.set(resource.id, operation.execute.bind(operation));
      }
    }
    for (const resource of resources)
      if (
        ![...groups.values()].some((group) => group.handlers.has(resource.id))
      )
        throw new Error(
          "Resource plugin must provide an operation for each resource",
        );
    for (const definition of workflows)
      if (!groups.get(definition.action)?.handlers.has(definition.resource))
        throw new Error(
          "Workflow references an unregistered resource or operation",
        );
    return {
      resources,
      operations: [...groups].map(([action, group]) => ({
        action,
        resourceKind: group.kind,
        execute(resource) {
          const handler = group.handlers.get(resource.id);
          if (!handler)
            throw new PermissionDenied(
              "Resource is not bound to this operation",
            );
          return handler(resource);
        },
      })),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function createConfiguredCapvine(options: CapvineOptions) {
  const fields = [
    "directory",
    "ownerId",
    "providers",
    "encryptionKey",
    "resources",
    "workflows",
    "port",
    "administrationPort",
    "workerCommand",
  ];
  if (Object.keys(options).some((key) => !fields.includes(key)))
    throw new Error("Unknown Capvine setup option");
  const settings = {
    ...options,
    workerCommand: options.workerCommand
      ? structuredClone(options.workerCommand)
      : undefined,
  };
  const providers = (options.providers ?? []).map((provider) => ({
    ...provider,
  }));
  const configured = options.resources
    ? configuration({
        resources: options.resources,
        workflows: options.workflows ?? [],
      })
    : undefined;
  const keyMode = options.encryptionKey ? "external" : "file";
  const externalKey = options.encryptionKey
    ? new Uint8Array(options.encryptionKey)
    : undefined;
  if (
    !isAbsolute(settings.directory) ||
    !settings.ownerId.trim() ||
    settings.ownerId.length > 256
  )
    throw new Error("Setup needs an absolute state directory and an owner ID");
  if (!configured && options.workflows?.length)
    throw new Error("Configure resources before workflows");
  if (externalKey && externalKey.length !== 32)
    throw new Error("The credential encryption key must contain 32 bytes");
  if (
    providers.length > 32 ||
    new Set(providers.map((p) => p.id)).size !== providers.length ||
    providers.some(
      (p) =>
        !/^[A-Za-z0-9._-]{1,128}$/.test(p.id) ||
        !p.binding ||
        [p.authorizationUrl, p.exchange, p.refresh, p.verify].some(
          (method) => typeof method !== "function",
        ),
    )
  )
    throw new Error("Configure at most 32 providers with unique IDs");
  for (const port of [settings.port ?? 8790, settings.administrationPort ?? 0])
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
      throw new Error("Ports must be integers from 0 to 65535");
  let fresh = false;
  try {
    await mkdir(settings.directory, { mode: 0o700 });
    fresh = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertPrivateDirectory(settings.directory);
  const lockPath = join(settings.directory, "setup.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let accounts: AccountManager | undefined;
  let runtime:
    | {
        service: Awaited<ReturnType<typeof startResourceServer>>;
        workflows: Awaited<ReturnType<typeof openWorkflowManager>> | undefined;
      }
    | undefined;
  let starting: Promise<NonNullable<typeof runtime>> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    return (closing ??= (async () => {
      await starting?.catch(() => {});
      const failures: unknown[] = [];
      for (const stop of [
        () => runtime?.workflows?.close(),
        () => runtime?.service.close(),
        () => accounts?.close(),
        () => lock.close(),
        () => unlink(lockPath),
      ]) {
        try {
          await stop();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Capvine shutdown failed");
    })());
  };
  try {
    await lock.writeFile(String(process.pid));
    const binding = JSON.stringify({
      version: 1,
      ownerId: settings.ownerId,
      encryptionKey: keyMode,
    });
    const bindingPath = join(settings.directory, "setup.json");
    if (fresh) {
      await initializeService(
        join(settings.directory, "service"),
        settings.ownerId,
      );
      await initializeIdentity(join(settings.directory, "coordinator.key"));
      if (!externalKey)
        await writePrivateFile(
          join(settings.directory, "accounts.key"),
          randomBytes(32).toString("base64url"),
        );
    } else {
      let saved: string;
      try {
        saved = await readPrivateFile(bindingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(
            "State directory is not initialized; use a new directory or restore complete setup state",
          );
        throw error;
      }
      if (saved !== binding)
        throw new Error(
          "Setup directory belongs to a different owner, version, or key configuration",
        );
    }
    const coordinator = await loadIdentity(
      join(settings.directory, "coordinator.key"),
    );
    const encryptionKey =
      externalKey ??
      Buffer.from(
        await readPrivateFile(join(settings.directory, "accounts.key")),
        "base64url",
      );
    if (encryptionKey.length !== 32)
      throw new Error("Invalid saved credential encryption key");
    const accountDirectory = join(settings.directory, "accounts");
    const accountState = await openAccountDatabase(
      accountDirectory,
      encryptionKey,
      fresh,
    );
    await accountState.close();
    if (fresh) await writePrivateFile(bindingPath, binding);
    await loadIdentity(join(settings.directory, "service/authority.key"));
    const operatorToken = await readPrivateFile(
      join(settings.directory, "service/admin.token"),
    );
    const state = await lstat(join(settings.directory, "service/state.db"));
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(operatorToken) ||
      !state.isFile() ||
      state.size === 0 ||
      state.nlink !== 1 ||
      state.uid !== process.getuid!() ||
      (state.mode & 0o077) !== 0
    )
      throw new Error("Authority state is incomplete");
    if (providers.length)
      accounts = await openAccountManager({
        directory: accountDirectory,
        key: encryptionKey,
        providers,
      });

    const start = (input: ResourceSetup) => {
      if (closed) return Promise.reject(new Error("Capvine is closing"));
      if (starting)
        return Promise.reject(
          new Error(
            "Resources already started; restart to change configuration",
          ),
        );
      const config = configuration(input);
      starting = (async () => {
        const adapter = await compose(
          config.resources,
          { ownerId: settings.ownerId, accounts },
          config.workflows,
        );
        const service = await startResourceServer({
          directory: join(settings.directory, "service"),
          owner: settings.ownerId,
          adapters: [adapter],
          port: settings.port ?? 8790,
          administrationPort: settings.administrationPort ?? 0,
        });
        try {
          const workflows = config.workflows.length
            ? await openWorkflowManager({
                directory: join(settings.directory, "workers"),
                ownerId: settings.ownerId,
                coordinator,
                service: service.principal,
                url: service.url,
                administration: createAdministrationClient({
                  url: service.administrationUrl,
                  token: await readPrivateFile(
                    join(settings.directory, "service/admin.token"),
                  ),
                }),
                workflows: config.workflows,
                ...(settings.workerCommand
                  ? { workerCommand: settings.workerCommand }
                  : {}),
              })
            : undefined;
          runtime = { service, workflows };
          return runtime;
        } catch (error) {
          await service.close();
          throw error;
        }
      })();
      return starting;
    };
    if (configured) await start(configured);
    return {
      ownerId: settings.ownerId,
      get accounts() {
        if (!accounts)
          throw new Error("Configure providers to use account connections");
        return accounts;
      },
      get service() {
        if (!runtime)
          throw new Error("Start resources before using the service");
        return runtime.service;
      },
      get workflows() {
        if (!runtime?.workflows)
          throw new Error(
            "Configure workflows before approving or provisioning workers",
          );
        return runtime.workflows;
      },
      start,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
