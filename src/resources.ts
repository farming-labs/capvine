import type { AccountManager } from "./accounts.ts";
import type { ResourceAdapter } from "./adapter.ts";
import { createFilesystemAdapter } from "./filesystem.ts";
import { createPostgresAdapter } from "./postgres.ts";
import { createGmailAdapter } from "./gmail.ts";
import { createSlackAdapter } from "./slack.ts";

export interface ResourceContext {
  ownerId: string;
  accounts: AccountManager | undefined;
}

export interface ResourcePlugin {
  name: string;
  open(context: ResourceContext): ResourceAdapter | Promise<ResourceAdapter>;
}

export function defineResource(plugin: ResourcePlugin): ResourcePlugin {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(plugin.name) ||
    typeof plugin.open !== "function"
  )
    throw new Error("Resource plugin needs a name and an open function");
  return Object.freeze({ ...plugin });
}

function accounts(context: ResourceContext): AccountManager {
  if (!context.accounts)
    throw new Error("This resource requires configured account providers");
  return context.accounts;
}

export function filesystem(
  options: Omit<Parameters<typeof createFilesystemAdapter>[0], "ownerId">,
): ResourcePlugin {
  const settings = structuredClone(options);
  return defineResource({
    name: "filesystem",
    open: ({ ownerId }) => createFilesystemAdapter({ ...settings, ownerId }),
  });
}

export function postgres(
  options: Omit<Parameters<typeof createPostgresAdapter>[0], "ownerId">,
): ResourcePlugin {
  const settings = {
    ...options,
    connection: { ...options.connection },
    records: structuredClone(options.records),
  };
  return defineResource({
    name: "postgres",
    open: ({ ownerId }) => createPostgresAdapter({ ...settings, ownerId }),
  });
}

export function gmail(
  options: Omit<
    Parameters<typeof createGmailAdapter>[0],
    "ownerId" | "accounts"
  >,
): ResourcePlugin {
  const settings = { ...options, messages: structuredClone(options.messages) };
  return defineResource({
    name: "gmail",
    open: (context) =>
      createGmailAdapter({
        ...settings,
        ownerId: context.ownerId,
        accounts: accounts(context),
      }),
  });
}

export function slackMessages(
  options: Omit<
    Parameters<typeof createSlackAdapter>[0],
    "ownerId" | "accounts"
  >,
): ResourcePlugin {
  const settings = { ...options, messages: structuredClone(options.messages) };
  return defineResource({
    name: "slack-messages",
    open: (context) =>
      createSlackAdapter({
        ...settings,
        ownerId: context.ownerId,
        accounts: accounts(context),
      }),
  });
}
