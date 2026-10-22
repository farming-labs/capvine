import { isDeepStrictEqual } from "node:util";
import type { AccountManager } from "./accounts.ts";
import type { ResourceAdapter } from "./adapter.ts";
import { slackObject, slackRequest } from "./slack-internal.ts";
import { PermissionDenied, type ResourceId } from "./types.ts";

export { createSlackProvider, type SlackHistoryScope } from "./slack-oauth.ts";

export function createSlackAdapter(options: {
  accounts: AccountManager;
  ownerId: string;
  messages: {
    id: ResourceId;
    connectionId: string;
    subject: string;
    channelId: string;
    timestamp: string;
  }[];
  fetch?: typeof fetch;
}): ResourceAdapter {
  if (
    !options.ownerId ||
    options.messages.length < 1 ||
    options.messages.length > 256
  )
    throw new Error("Invalid Slack configuration");
  const accounts = options.accounts;
  const request = options.fetch;
  const resources = options.messages.map((message) => {
    const account = accounts.inspect(options.ownerId, message.connectionId);
    if (
      !message.id.startsWith("urn:capvine:resource:") ||
      !/^[CGD][A-Z0-9]{1,63}$/.test(message.channelId) ||
      !/^[0-9]{1,16}\.[0-9]{6}$/.test(message.timestamp) ||
      !/^slack:T[A-Z0-9]{1,63}:[UW][A-Z0-9]{1,63}$/.test(message.subject) ||
      account.provider !== "slack" ||
      account.status !== "connected" ||
      account.subject !== message.subject
    )
      throw new Error("Invalid Slack binding");
    return {
      id: message.id,
      ownerId: options.ownerId,
      kind: "slack.message",
      target: {
        connectionId: message.connectionId,
        subject: message.subject,
        channelId: message.channelId,
        timestamp: message.timestamp,
      },
    };
  });
  const registered = new Map(
    resources.map((resource) => [resource.id, structuredClone(resource)]),
  );
  if (registered.size !== resources.length)
    throw new Error("Duplicate Slack resource");
  return {
    resources,
    operations: [
      {
        action: "slack/message.read",
        resourceKind: "slack.message",
        async execute(resource) {
          if (!isDeepStrictEqual(resource, registered.get(resource.id)))
            throw new PermissionDenied("Unknown Slack binding");
          try {
            return await accounts.withAccessToken(
              {
                ownerId: resource.ownerId,
                connectionId: resource.target.connectionId!,
                provider: "slack",
                subject: resource.target.subject!,
              },
              async (token) => {
                const value = await slackRequest("conversations.history", {
                  token,
                  fields: {
                    channel: resource.target.channelId!,
                    oldest: resource.target.timestamp!,
                    latest: resource.target.timestamp!,
                    inclusive: "true",
                    limit: "1",
                  },
                  ...(request ? { fetch: request } : {}),
                });
                if (
                  !Array.isArray(value.messages) ||
                  value.messages.length !== 1
                )
                  throw new Error("Slack message unavailable");
                const message = slackObject(value.messages[0]);
                if (
                  message.type !== "message" ||
                  message.ts !== resource.target.timestamp ||
                  typeof message.text !== "string" ||
                  message.text.length > 16_384
                )
                  throw new Error("Invalid Slack message");
                return {
                  channelId: resource.target.channelId!,
                  timestamp: resource.target.timestamp!,
                  text: message.text,
                };
              },
            );
          } catch {
            throw new Error("Slack read failed");
          }
        },
      },
    ],
    async close() {},
  };
}
