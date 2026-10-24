import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { opendir } from "node:fs/promises";
import type { AccountManager } from "./accounts.ts";
import type { ResourceAdapter } from "./adapter.ts";
import type { ResourceId } from "./types.ts";
import type {
  RegisterResourceInput,
  ResourceChoices,
} from "./application-contract.ts";
import { record, string } from "./application-contract.ts";
import { createGmailAdapter } from "./gmail.ts";
import { createSlackAdapter } from "./slack.ts";
import { createFilesystemAdapter } from "./filesystem.ts";
import { createPostgresAdapter, type PostgresRecord } from "./postgres.ts";
import { boundedFetch } from "./oauth.ts";

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
  discover?(context: {
    ownerId: string;
    accounts: AccountManager | undefined;
    connectionId?: string;
    after?: string;
  }): ResourceChoices | Promise<ResourceChoices>;
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
    typeof plugin.open !== "function" ||
    (plugin.discover !== undefined && typeof plugin.discover !== "function")
  )
    throw new Error("Invalid plugin definition");
  return Object.freeze({ ...plugin, actions: [...plugin.actions] });
}

function configuration(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function connected(
  context: Pick<PluginContext, "ownerId" | "accounts">,
  connectionId: string | undefined,
  provider: string,
) {
  if (!context.accounts || !connectionId)
    throw new Error("Select a connected account");
  const account = context.accounts.inspect(context.ownerId, connectionId);
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
    async discover(context) {
      const account = connected(context, context.connectionId, "google");
      return account.accounts.withAccessToken(
        {
          ownerId: context.ownerId,
          provider: "google",
          connectionId: account.connectionId,
          subject: account.subject,
        },
        async (token) => {
          const headers = { authorization: `Bearer ${token}` };
          const url = new URL(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          );
          url.searchParams.set("maxResults", "10");
          if (context.after) url.searchParams.set("pageToken", context.after);
          const response = await boundedFetch(
            url.href,
            { headers },
            settings.fetch,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Message listing failed");
          }
          const data = await response.json();
          const messages = data.messages ?? [];
          if (
            !Array.isArray(messages) ||
            messages.length > 10 ||
            messages.some(
              (m: { id?: unknown }) =>
                !m ||
                typeof m.id !== "string" ||
                !/^[a-fA-F0-9]{1,128}$/.test(m.id),
            )
          )
            throw new Error("Invalid message listing");
          const items = await Promise.all(
            messages.map(async (message: { id: string }) => {
              const response = await boundedFetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject`,
                { headers },
                settings.fetch,
              );
              if (!response.ok) {
                await response.body?.cancel();
                throw new Error("Message preview failed");
              }
              const data = await response.json();
              if (
                data.id !== message.id ||
                !Array.isArray(data.payload?.headers)
              )
                throw new Error("Invalid message metadata");
              const subject = data.payload.headers.find(
                (h: { name?: unknown } | null) =>
                  typeof h?.name === "string" &&
                  h.name.toLowerCase() === "subject",
              )?.value;
              if (subject !== undefined && typeof subject !== "string")
                throw new Error("Invalid subject");
              return {
                label: (subject || "(No subject)").slice(0, 256),
                target: { messageId: message.id },
              };
            }),
          );
          return {
            items,
            nextCursor:
              data.nextPageToken === undefined
                ? null
                : string(data.nextPageToken, 2048),
          };
        },
      );
    },
    open(context) {
      const target = record(context.selection.target, ["messageId"]);
      const account = connected(
        context,
        context.selection.connectionId,
        "google",
      );
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
      const account = connected(
        context,
        context.selection.connectionId,
        "slack",
      );
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
    async discover(context) {
      if (context.connectionId !== undefined)
        throw new Error("Files do not use accounts");
      const directory = await opendir(settings.root);
      const files: string[] = [];
      let scanned = 0;
      for await (const entry of directory) {
        if (++scanned > 4096)
          throw new Error("Directory discovery limit exceeded");
        if (entry.isFile()) files.push(entry.name);
      }
      const names = files
        .sort()
        .filter((name) => name > (context.after ?? ""))
        .slice(0, 26);
      return {
        items: names
          .slice(0, 25)
          .map((path) => ({ label: path.slice(0, 256), target: { path } })),
        nextCursor: names.length > 25 ? names[24]! : null,
      };
    },
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
