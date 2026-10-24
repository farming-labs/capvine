import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AccountManager } from "./accounts.ts";
import type { ResourceAdapter } from "./adapter.ts";
import type { ResourceId } from "./types.ts";
import type { RegisterResourceInput } from "./application-contract.ts";
import { record, string } from "./application-contract.ts";
import { createGmailAdapter } from "./gmail.ts";
import { createSlackAdapter } from "./slack.ts";
import { createFilesystemAdapter } from "./filesystem.ts";
import { createPostgresAdapter, type PostgresRecord } from "./postgres.ts";

export interface PluginContext {
  id: ResourceId;
  ownerId: string;
  accounts: AccountManager | undefined;
  selection: RegisterResourceInput;
}

export interface CapvinePlugin {
  id: string;
  type: string;
  configuration: string;
  actions: string[];
  open(context: PluginContext): ResourceAdapter | Promise<ResourceAdapter>;
}

export function definePlugin(plugin: CapvinePlugin): CapvinePlugin {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id) ||
    !/^[a-z][a-z0-9.-]{0,127}$/.test(plugin.type) ||
    !plugin.configuration ||
    plugin.configuration.length > 4096 ||
    !Array.isArray(plugin.actions) ||
    !plugin.actions.length ||
    plugin.actions.length > 16 ||
    new Set(plugin.actions).size !== plugin.actions.length ||
    plugin.actions.some(
      (action) =>
        typeof action !== "string" ||
        !/^[a-z][a-z0-9/._-]{0,127}$/.test(action),
    ) ||
    typeof plugin.open !== "function"
  )
    throw new Error("Invalid plugin definition");
  return Object.freeze({ ...plugin, actions: [...plugin.actions] });
}

function configuration(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function connected(context: PluginContext, provider: string) {
  if (!context.accounts || !context.selection.connectionId)
    throw new Error("Select a connected account");
  const account = context.accounts.inspect(
    context.ownerId,
    context.selection.connectionId,
  );
  if (
    account.provider !== provider ||
    account.status !== "connected" ||
    !account.subject
  )
    throw new Error("Account is not connected to this provider");
  return {
    accounts: context.accounts,
    connectionId: account.id,
    subject: account.subject,
  };
}

export function gmail(
  options: { id?: string; fetch?: typeof fetch } = {},
): CapvinePlugin {
  const settings = { ...options };
  return definePlugin({
    id: settings.id ?? "gmail",
    type: "gmail.message",
    configuration: "gmail.message/v1",
    actions: ["gmail/message.read"],
    open(context) {
      const target = record(context.selection.target, ["messageId"]);
      const account = connected(context, "google");
      return createGmailAdapter({
        accounts: account.accounts,
        ownerId: context.ownerId,
        messages: [
          {
            id: context.id,
            connectionId: account.connectionId,
            subject: account.subject,
            messageId: string(target.messageId),
          },
        ],
        ...(settings.fetch ? { fetch: settings.fetch } : {}),
      });
    },
  });
}

export function slackMessages(
  options: { id?: string; fetch?: typeof fetch } = {},
): CapvinePlugin {
  const settings = { ...options };
  return definePlugin({
    id: settings.id ?? "slack",
    type: "slack.message",
    configuration: "slack.message/v1",
    actions: ["slack/message.read"],
    open(context) {
      const target = record(context.selection.target, [
        "channelId",
        "timestamp",
      ]);
      const account = connected(context, "slack");
      return createSlackAdapter({
        accounts: account.accounts,
        ownerId: context.ownerId,
        messages: [
          {
            id: context.id,
            connectionId: account.connectionId,
            subject: account.subject,
            channelId: string(target.channelId),
            timestamp: string(target.timestamp),
          },
        ],
        ...(settings.fetch ? { fetch: settings.fetch } : {}),
      });
    },
  });
}

export function filesystem(options: {
  id: string;
  root: string;
  maxBytes?: number;
}): CapvinePlugin {
  const settings = { ...options };
  if (!isAbsolute(settings.root))
    throw new Error("Filesystem root must be absolute");
  return definePlugin({
    id: settings.id,
    type: "fs.file",
    configuration: configuration([
      "fs.file/v1",
      settings.root,
      settings.maxBytes ?? 131072,
    ]),
    actions: ["fs/read"],
    open(context) {
      if (context.selection.connectionId !== undefined)
        throw new Error("Filesystem resources do not use OAuth accounts");
      const target = record(context.selection.target, ["path"]);
      return createFilesystemAdapter({
        ...settings,
        connectionId: settings.id,
        ownerId: context.ownerId,
        files: [{ id: context.id, path: string(target.path) }],
      });
    },
  });
}

export function postgres(
  options: Omit<
    Parameters<typeof createPostgresAdapter>[0],
    "connectionId" | "ownerId" | "records"
  > & { id: string },
): CapvinePlugin {
  const settings = { ...options, connection: { ...options.connection } };
  const connection = settings.connection;
  if (
    connection.connectionString ||
    connection.host === undefined ||
    connection.database === undefined ||
    connection.user === undefined
  )
    throw new Error(
      "Postgres plugin requires explicit host, database, and user; connectionString is unsupported",
    );
  return definePlugin({
    id: settings.id,
    type: "pg.record",
    configuration: configuration([
      "postgres.record/v1",
      settings.databaseId,
      connection.host,
      connection.port ?? 5432,
      connection.database,
      connection.user,
      settings.maxBytes ?? 131072,
    ]),
    actions: ["pg/record.read"],
    open(context) {
      if (context.selection.connectionId !== undefined)
        throw new Error("Postgres resources do not use OAuth accounts");
      const target = record(context.selection.target, [
        "schema",
        "table",
        "key",
        "tenant",
        "columns",
      ]);
      record(target.key, ["column", "value"]);
      record(target.tenant, ["column", "value"]);
      if (!Array.isArray(target.columns))
        throw new Error("Select record columns");
      return createPostgresAdapter({
        ...settings,
        connectionId: settings.id,
        ownerId: context.ownerId,
        records: [{ ...target, id: context.id } as PostgresRecord],
      });
    },
  });
}
