import { isAbsolute } from "node:path";
import { openAccountManager } from "../../src/accounts.ts";
import { createGoogleProvider } from "../../src/oauth.ts";
import { createGmailAdapter } from "../../src/gmail.ts";
import {
  createSlackAdapter,
  createSlackProvider,
  type SlackHistoryScope,
} from "../../src/slack.ts";
import { readPrivateFile } from "../../src/identity-file.ts";
import { checkProviderRead, checkProviderRejection } from "./check.ts";

function object(value: unknown, fields: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error("Invalid configuration fields");
  return value as Record<string, unknown>;
}
function text(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new Error("Invalid configuration value");
  return value;
}
function path(value: unknown) {
  const result = text(value);
  if (!isAbsolute(result)) throw new Error("Absolute private path required");
  return result;
}
try {
  const [mode, configPath, ...extra] = process.argv.slice(2);
  if (
    !["read", "expect-rejected"].includes(mode ?? "") ||
    !configPath ||
    extra.length
  )
    throw new Error("Invalid arguments");
  const config = object(
    JSON.parse(await readPrivateFile(path(configPath), 16_384)),
    [
      "directory",
      "encryptionKeyFile",
      "ownerId",
      "connectionId",
      "subject",
      "provider",
      "message",
    ],
  );
  const directory = path(config.directory);
  const encryptionKeyFile = path(config.encryptionKeyFile);
  const ownerId = text(config.ownerId);
  const connectionId = text(config.connectionId);
  const subject = text(config.subject);
  const rawProvider = config.provider as Record<string, unknown> | undefined;
  const kind = rawProvider?.type;
  let provider;
  let message;
  if (kind === "google") {
    const p = object(config.provider, [
      "type",
      "clientIdFile",
      "clientSecretFile",
      "redirectUri",
    ]);
    provider = createGoogleProvider({
      clientId: await readPrivateFile(path(p.clientIdFile)),
      clientSecret: await readPrivateFile(path(p.clientSecretFile)),
      redirectUri: text(p.redirectUri),
    });
    const m = object(config.message, ["messageId"]);
    message = { messageId: text(m.messageId) };
  } else if (kind === "slack") {
    const p = object(config.provider, [
      "type",
      "clientId",
      "appId",
      "redirectUri",
      "scopes",
    ]);
    if (
      !Array.isArray(p.scopes) ||
      p.scopes.some((scope) => typeof scope !== "string")
    )
      throw new Error("Invalid scopes");
    provider = createSlackProvider({
      clientId: text(p.clientId),
      appId: text(p.appId),
      redirectUri: text(p.redirectUri),
      scopes: p.scopes as SlackHistoryScope[],
    });
    const m = object(config.message, ["channelId", "timestamp"]);
    message = { channelId: text(m.channelId), timestamp: text(m.timestamp) };
  } else throw new Error("Unknown provider");
  const activity = { refreshes: 0, verifications: 0 };
  const counted = {
    ...provider,
    refresh: async (...args: Parameters<typeof provider.refresh>) => {
      const result = await provider.refresh(...args);
      activity.refreshes++;
      return result;
    },
    verify: async (...args: Parameters<typeof provider.verify>) => {
      await provider.verify(...args);
      activity.verifications++;
    },
  };
  const openAccounts = async () => {
    const encoded = await readPrivateFile(encryptionKeyFile);
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("Invalid key");
    const key = Buffer.from(encoded, "base64url");
    try {
      return await openAccountManager({ directory, key, providers: [counted] });
    } finally {
      key.fill(0);
    }
  };
  const binding = {
    id: "urn:capvine:resource:validation-message" as const,
    connectionId,
    subject,
  };
  const result =
    mode === "expect-rejected"
      ? await checkProviderRejection({
          ownerId,
          connectionId,
          subject,
          provider: provider.id,
          openAccounts,
        })
      : await checkProviderRead({
          ownerId,
          openAccounts,
          adapter: (accounts) =>
            "messageId" in message
              ? createGmailAdapter({
                  accounts,
                  ownerId,
                  messages: [{ ...binding, messageId: message.messageId }],
                })
              : createSlackAdapter({
                  accounts,
                  ownerId,
                  messages: [
                    {
                      ...binding,
                      channelId: message.channelId,
                      timestamp: message.timestamp,
                    },
                  ],
                }),
        });
  console.log(
    JSON.stringify({
      provider: provider.id,
      mode,
      passed: result,
      activity,
      note: "Provider consent, reconnect with fresh bindings, and host isolation require separately recorded evidence. No account or message content is included.",
    }),
  );
} catch {
  console.error(
    "Provider validation did not pass. Check private configuration, stop other processes using the account directory, and inspect account status. A temporary provider error is not proof of revocation. See docs/provider-validation.md.",
  );
  process.exitCode = 1;
}
