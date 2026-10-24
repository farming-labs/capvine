import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ed25519 } from "@ucanto/principal";
import { createConfiguredCapvine } from "./setup-internal.ts";
import { loadIdentity } from "./identity-file.ts";
import { SqliteStore } from "./sqlite.ts";
import { createAuthority } from "./server.ts";
import { encodeGrant } from "./profile.ts";
import { definePlugin, type CapvinePlugin } from "./plugins.ts";
import type { AccountProvider } from "./accounts.ts";
import type { ProviderDefinition } from "./providers.ts";
import type { ResourceAdapter } from "./adapter.ts";
import {
  PermissionDenied,
  type Json,
  type Resource,
  type ResourceId,
} from "./types.ts";
import {
  contentType,
  maxRequestBytes,
  maxResponseBytes,
} from "./http-internal.ts";
import {
  applicationURL,
  basePath,
  CapvineAPIError,
  readBody,
  record,
  string,
  type Command,
  type CommandInput,
  type CommandOutput,
  type RegisteredResource,
  type RegisterResourceInput,
} from "./application-contract.ts";

export interface OwnerSession {
  ownerId: string;
  sessionId: string;
}

export interface ApplicationOptions {
  baseURL: string;
  storage: { directory: string; encryptionKey?: Uint8Array };
  ownerId: string;
  authenticate(
    request: Request,
  ): OwnerSession | null | Promise<OwnerSession | null>;
  providers?: (AccountProvider | ProviderDefinition)[];
  plugins: CapvinePlugin[];
}

interface Registration {
  version: 1;
  plugin: string;
  configuration: string;
  actions: string[];
  selection: RegisterResourceInput;
  resource: Resource;
}

function selection(value: unknown): RegisterResourceInput {
  const input = record(value, ["type", "target"], ["plugin", "connectionId"]);
  const target = input.target;
  if (
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    Object.keys(target).length > 32 ||
    JSON.stringify(target).length > 16384
  )
    throw new CapvineAPIError(400, "invalid_target");
  return structuredClone({
    type: string(input.type, 128),
    target: target as Record<string, Json>,
    ...(input.plugin === undefined ? {} : { plugin: string(input.plugin, 64) }),
    ...(input.connectionId === undefined
      ? {}
      : { connectionId: string(input.connectionId, 128) }),
  });
}

function response(status: number, value: unknown): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function failure(error: unknown): Response {
  if (error instanceof CapvineAPIError)
    return response(error.status, { error: { code: error.code } });
  if (error instanceof PermissionDenied)
    return response(403, { error: { code: "permission_denied" } });
  return response(500, { error: { code: "request_failed" } });
}

export async function createApplication(options: ApplicationOptions) {
  record(
    options,
    ["baseURL", "storage", "ownerId", "authenticate", "plugins"],
    ["providers"],
  );
  record(options.storage, ["directory"], ["encryptionKey"]);
  const origin = applicationURL(options.baseURL).origin;
  if (
    typeof options.authenticate !== "function" ||
    !Array.isArray(options.plugins) ||
    !options.plugins.length ||
    options.plugins.length > 32
  )
    throw new Error(
      "Configure an owner authenticator and between 1 and 32 plugins",
    );
  const authenticate = options.authenticate;
  const ownerId = string(options.ownerId, 256);
  const plugins = options.plugins.map(definePlugin);
  if (new Set(plugins.map((p) => p.id)).size !== plugins.length)
    throw new Error("Plugin IDs must be unique");
  const operations = new Map<string, string>();
  for (const plugin of plugins)
    for (const action of plugin.actions) {
      const existing = operations.get(action);
      if (existing && existing !== plugin.type)
        throw new Error("An action cannot span different resource types");
      operations.set(action, plugin.type);
    }
  const callbackURL = `${origin}${basePath}/callback`;
  const invocationURL = `${origin}${basePath}/invoke`;
  const providers = (options.providers ?? []).map((provider) =>
    "create" in provider ? provider.create(callbackURL) : provider,
  );
  const foundation = await createConfiguredCapvine({
    directory: options.storage.directory,
    ownerId,
    providers,
    ...(options.storage.encryptionKey
      ? { encryptionKey: options.storage.encryptionKey }
      : {}),
  });
  let store: SqliteStore | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<Response>>();
  const adapters = new Map<string, Promise<ResourceAdapter>>();
  const registered = new Map<string, Registration>();
  const accounts = providers.length ? foundation.accounts : undefined;
  const close = () => {
    closed = true;
    return (closing ??= (async () => {
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled(
        [...adapters.values()].map(async (adapter) => (await adapter).close()),
      );
      try {
        store?.close();
      } finally {
        await foundation.close();
      }
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Plugin cleanup failed");
    })());
  };
  try {
    const signer = await loadIdentity(
      join(options.storage.directory, "service", "authority.key"),
    );
    store = new SqliteStore(
      join(options.storage.directory, "service", "state.db"),
    );
    store.bindService(signer.did(), ownerId);
    store.bindApplication(origin, ownerId);
    const state = store;
    for (const row of state.registrations()) {
      const value = record(row, [
        "version",
        "plugin",
        "configuration",
        "actions",
        "selection",
        "resource",
      ]);
      const item = value as unknown as Registration;
      if (
        item.version !== 1 ||
        item.resource?.ownerId !== ownerId ||
        typeof item.resource.id !== "string" ||
        !item.resource.id.startsWith("urn:capvine:resource:") ||
        registered.has(item.resource.id) ||
        !isDeepStrictEqual(
          state.getResource(item.resource.id),
          item.resource,
        ) ||
        typeof item.configuration !== "string" ||
        !Array.isArray(item.actions) ||
        item.actions.some((a) => typeof a !== "string") ||
        item.selection.type !== item.resource.kind ||
        item.selection.plugin !== item.plugin
      )
        throw new Error("Invalid persistent resource registration");
      selection(item.selection);
      registered.set(item.resource.id, item);
    }
    if (registered.size > 256)
      throw new Error("Resource registration limit exceeded");
    function pluginFor(item: Registration) {
      const plugin = plugins.find(
        (p) =>
          p.id === item.plugin &&
          p.type === item.resource.kind &&
          p.configuration === item.configuration &&
          isDeepStrictEqual(p.actions, item.actions),
      );
      if (!plugin)
        throw new PermissionDenied(
          "Registered plugin configuration is unavailable",
        );
      return plugin;
    }
    async function openAdapter(
      plugin: CapvinePlugin,
      id: ResourceId,
      input: RegisterResourceInput,
      expected?: Resource,
    ) {
      const adapter = await plugin.open({
        id,
        ownerId,
        accounts,
        selection: structuredClone(input),
      });
      try {
        const resource = adapter.resources[0];
        if (
          adapter.resources.length !== 1 ||
          !resource ||
          resource.id !== id ||
          resource.ownerId !== ownerId ||
          resource.kind !== plugin.type ||
          adapter.operations.length !== plugin.actions.length ||
          new Set(adapter.operations.map((o) => o.action)).size !==
            plugin.actions.length ||
          adapter.operations.some(
            (o) =>
              o.resourceKind !== plugin.type ||
              !plugin.actions.includes(o.action),
          ) ||
          (expected && !isDeepStrictEqual(resource, expected))
        )
          throw new PermissionDenied("Plugin changed the resource binding");
        return adapter;
      } catch (error) {
        await adapter.close();
        throw error;
      }
    }
    function adapterFor(item: Registration) {
      const plugin = pluginFor(item);
      if (
        item.selection.connectionId &&
        (!accounts ||
          accounts.inspect(ownerId, item.selection.connectionId).status !==
            "connected")
      )
        throw new PermissionDenied("Account is not connected");
      let opened = adapters.get(item.resource.id);
      if (!opened) {
        opened = openAdapter(
          plugin,
          item.resource.id,
          item.selection,
          item.resource,
        );
        adapters.set(item.resource.id, opened);
        void opened.catch(() => {
          if (adapters.get(item.resource.id) === opened)
            adapters.delete(item.resource.id);
        });
      }
      return opened;
    }
    const authority = createAuthority({
      signer,
      store: state,
      authorizeGrant: ({ actor, resource, task }) =>
        actor === ownerId &&
        resource.ownerId === ownerId &&
        task.ownerId === ownerId &&
        registered.has(resource.id),
    });
    for (const [action, type] of operations)
      authority.registerOperation({
        action,
        resourceKind: type,
        async execute(resource) {
          const item = registered.get(resource.id);
          if (!item || !isDeepStrictEqual(item.resource, resource))
            throw new PermissionDenied("Unknown resource");
          const adapter = await adapterFor(item);
          const operation = adapter.operations.find(
            (op) => op.action === action,
          );
          if (!operation) throw new PermissionDenied("Unknown operation");
          return operation.execute(resource);
        },
      });
    function metadata(item: Registration): RegisteredResource {
      return {
        id: item.resource.id,
        type: item.resource.kind,
        plugin: item.plugin,
        ...(item.selection.connectionId
          ? { connectionId: item.selection.connectionId }
          : {}),
        actions: [...item.actions],
      };
    }
    function returnPath(value: unknown): string {
      const path = string(value ?? "/", 2048);
      const url = new URL(path, origin);
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("\\") ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.pathname.startsWith(basePath)
      )
        throw new CapvineAPIError(400, "invalid_return_path");
      return url.href;
    }
    async function owner(request: Request): Promise<OwnerSession> {
      const session = await authenticate(request);
      if (!session) throw new CapvineAPIError(401, "authentication_required");
      if (session.ownerId !== ownerId)
        throw new CapvineAPIError(403, "owner_required");
      if (
        typeof session.sessionId !== "string" ||
        session.sessionId.length < 1 ||
        session.sessionId.length > 1024
      )
        throw new CapvineAPIError(401, "invalid_session");
      return {
        ownerId,
        sessionId: createHash("sha256")
          .update(session.sessionId)
          .digest("base64url"),
      };
    }
    function requireAccounts() {
      if (!accounts) throw new CapvineAPIError(400, "providers_not_configured");
      return accounts;
    }
    let registrationsInFlight = 0;
    async function command(
      name: string,
      value: unknown,
      session: OwnerSession,
    ): Promise<unknown> {
      switch (name) {
        case "connections/connect": {
          const input = record(value, ["provider"], ["returnTo"]);
          const provider = string(input.provider, 128);
          if (!providers.some((p) => p.id === provider))
            throw new CapvineAPIError(400, "unknown_provider");
          const started = await requireAccounts().begin({
            ...session,
            connectionId: randomUUID(),
            provider,
            returnTo: returnPath(input.returnTo),
          });
          const url = new URL(started.url);
          if (
            url.searchParams.get("redirect_uri") !== callbackURL ||
            (url.protocol !== "https:" &&
              !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
              )) ||
            url.username ||
            url.password
          )
            throw new CapvineAPIError(400, "provider_callback_mismatch");
          return started;
        }
        case "connections/list": {
          const input = record(value, [], ["after"]);
          return requireAccounts().list(ownerId, {
            ...(input.after === undefined
              ? {}
              : { after: string(input.after, 32) }),
            limit: 25,
          });
        }
        case "connections/disconnect": {
          const input = record(value, ["connectionId"]);
          requireAccounts().disconnect(
            ownerId,
            string(input.connectionId, 128),
          );
          return { disconnected: true };
        }
        case "resources/register": {
          const input = selection(value);
          const matches = plugins.filter(
            (plugin) =>
              plugin.type === input.type &&
              (input.plugin === undefined || input.plugin === plugin.id),
          );
          if (matches.length !== 1)
            throw new CapvineAPIError(400, "select_one_plugin");
          const plugin = matches[0]!;
          input.plugin = plugin.id;
          if (registered.size + registrationsInFlight >= 256)
            throw new CapvineAPIError(409, "resource_limit");
          registrationsInFlight++;
          let adapter: ResourceAdapter | undefined;
          try {
            const id: ResourceId = `urn:capvine:resource:${randomUUID()}`;
            try {
              adapter = await openAdapter(plugin, id, input);
            } catch {
              throw new CapvineAPIError(400, "invalid_resource");
            }
            const item: Registration = {
              version: 1,
              plugin: plugin.id,
              configuration: plugin.configuration,
              actions: [...plugin.actions],
              selection: input,
              resource: structuredClone(adapter.resources[0]!),
            };
            state.registerResource(item.resource, item);
            registered.set(id, item);
            adapters.set(id, Promise.resolve(adapter));
            adapter = undefined;
            return metadata(item);
          } finally {
            registrationsInFlight--;
            await adapter?.close();
          }
        }
        case "resources/list": {
          const input = record(value, [], ["after"]);
          const after = input.after === undefined ? "" : string(input.after);
          const items = [...registered.values()]
            .sort((a, b) => a.resource.id.localeCompare(b.resource.id))
            .filter((item) => item.resource.id > after)
            .slice(0, 26);
          return {
            resources: items.slice(0, 25).map(metadata),
            nextCursor: items.length > 25 ? items[24]!.resource.id : null,
          };
        }
        case "grants/issue": {
          const input = record(
            value,
            ["resource", "action", "audience"],
            ["expiresIn"],
          );
          const item = registered.get(string(input.resource));
          const action = string(input.action, 128);
          const expiresIn = input.expiresIn ?? 300;
          if (
            !Number.isSafeInteger(expiresIn) ||
            (expiresIn as number) < 1 ||
            (expiresIn as number) > 3600
          )
            throw new CapvineAPIError(400, "invalid_lifetime");
          let audience;
          try {
            audience = ed25519.Verifier.parse(
              string(input.audience) as `did:key:${string}`,
            );
          } catch {
            throw new CapvineAPIError(400, "invalid_audience");
          }
          if (!item || !pluginFor(item).actions.includes(action))
            throw new PermissionDenied("Unknown resource or action");
          await adapterFor(item);
          const taskId = `grant:${randomUUID()}`;
          state.addTask({ id: taskId, ownerId, active: true });
          try {
            const grant = await authority.issue({
              actor: ownerId,
              resource: item.resource.id,
              action,
              audience,
              taskId,
              expiresAt: new Date(Date.now() + (expiresIn as number) * 1000),
            });
            return {
              id: grant.cid.toString(),
              grant: Buffer.from(await encodeGrant(grant)).toString("base64"),
              resource: item.resource.id,
              action,
              audience: audience.did(),
              expiresAt: grant.expiration,
              service: signer.did(),
              invocationURL,
            };
          } catch (error) {
            state.endTask(taskId);
            throw error;
          }
        }
        case "grants/revoke": {
          const input = record(value, ["id"]);
          const id = string(input.id);
          const grant = state.getGrant(id);
          if (!grant || !registered.has(grant.resourceId))
            throw new PermissionDenied("Unknown grant");
          state.revoke(id);
          return { revoked: true };
        }
        default:
          throw new CapvineAPIError(404, "not_found");
      }
    }
    async function handle(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.origin !== origin || !url.pathname.startsWith(`${basePath}/`))
          throw new CapvineAPIError(404, "not_found");
        if (url.href.length > 16384)
          throw new CapvineAPIError(413, "url_too_large");
        const route = url.pathname.slice(basePath.length + 1);
        if (route === "callback") {
          if (request.method !== "GET")
            throw new CapvineAPIError(405, "method_not_allowed");
          const session = await owner(request);
          const connection = await requireAccounts()
            .complete({ ...session, callback: url })
            .catch(() => {
              throw new CapvineAPIError(400, "connection_failed");
            });
          const destination = new URL(connection.returnTo ?? "/", origin);
          if (destination.origin !== origin)
            throw new CapvineAPIError(400, "invalid_return_path");
          const location = returnPath(
            destination.pathname + destination.search + destination.hash,
          );
          return new Response(null, {
            status: 303,
            headers: {
              location,
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          });
        }
        if (url.search || request.method !== "POST")
          throw new CapvineAPIError(405, "method_not_allowed");
        if (route === "invoke") {
          if (request.headers.has("origin"))
            throw new CapvineAPIError(403, "browser_origin_not_supported");
          if (request.headers.get("content-type") !== contentType)
            throw new CapvineAPIError(415, "unsupported_media_type");
          const value = await authority.execute(
            await readBody(request.body, maxRequestBytes),
          );
          if (Buffer.byteLength(JSON.stringify(value)) > maxResponseBytes)
            throw new CapvineAPIError(502, "result_too_large");
          return response(200, { ok: value });
        }
        if (
          request.headers.get("origin") !== origin ||
          request.headers.get("x-capvine-request") !== "1" ||
          ["cross-site", "same-site"].includes(
            request.headers.get("sec-fetch-site") ?? "",
          )
        )
          throw new CapvineAPIError(403, "origin_required");
        if (request.headers.get("content-type") !== "application/json")
          throw new CapvineAPIError(415, "unsupported_media_type");
        const session = await owner(request);
        let input;
        try {
          input = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              await readBody(request.body, 32768),
            ),
          );
        } catch (error) {
          if (error instanceof CapvineAPIError) throw error;
          throw new CapvineAPIError(400, "invalid_json");
        }
        return response(200, { data: await command(route, input, session) });
      } catch (error) {
        return failure(error);
      }
    }
    const handler = (request: Request): Promise<Response> => {
      if (closed)
        return Promise.resolve(response(503, { error: { code: "closing" } }));
      if (pending.size >= 16)
        return Promise.resolve(response(429, { error: { code: "busy" } }));
      const result = handle(request);
      pending.add(result);
      void result.finally(() => pending.delete(result));
      return result;
    };
    function method<K extends Command>(name: K) {
      return async (
        input: { headers: HeadersInit } & ({} extends CommandInput<K>
          ? { body?: CommandInput<K> }
          : { body: CommandInput<K> }),
      ): Promise<CommandOutput<K>> => {
        const headers = new Headers(input.headers);
        headers.set("content-type", "application/json");
        headers.set("x-capvine-request", "1");
        const result = await handler(
          new Request(`${origin}${basePath}/${name}`, {
            method: "POST",
            headers,
            body: JSON.stringify(input.body ?? {}),
          }),
        );
        const value = await result.json();
        if (!result.ok)
          throw new CapvineAPIError(result.status, value.error.code);
        return value.data as CommandOutput<K>;
      };
    }
    const api = {
      connections: {
        connect: method("connections/connect"),
        list: method("connections/list"),
        disconnect: method("connections/disconnect"),
      },
      resources: {
        register: method("resources/register"),
        list: method("resources/list"),
      },
      grants: {
        issue: method("grants/issue"),
        revoke: method("grants/revoke"),
      },
    };
    return {
      handler,
      api,
      service: { did: signer.did(), invocationURL, callbackURL },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
