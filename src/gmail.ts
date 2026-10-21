import { isDeepStrictEqual } from "node:util";
import type { AccountManager } from "./accounts.ts";
import type { ResourceAdapter } from "./adapter.ts";
import { boundedFetch } from "./oauth.ts";
import { PermissionDenied, type ResourceId } from "./types.ts";

export function createGmailAdapter(options: {
  accounts: AccountManager;
  ownerId: string;
  messages: {
    id: ResourceId;
    connectionId: string;
    subject: string;
    messageId: string;
  }[];
  fetch?: typeof fetch;
}): ResourceAdapter {
  if (
    !options.ownerId ||
    options.messages.length < 1 ||
    options.messages.length > 256
  )
    throw new Error("Invalid Gmail configuration");
  const accounts = options.accounts;
  const request = options.fetch;
  const resources = options.messages.map((message) => {
    const account = accounts.inspect(options.ownerId, message.connectionId);
    if (
      !message.id.startsWith("urn:capvine:resource:") ||
      !/^[a-fA-F0-9]{1,128}$/.test(message.messageId) ||
      account.provider !== "google" ||
      account.status !== "connected" ||
      account.subject !== message.subject
    )
      throw new Error("Invalid Gmail binding");
    return {
      id: message.id,
      ownerId: options.ownerId,
      kind: "gmail.message",
      target: {
        connectionId: message.connectionId,
        subject: message.subject,
        messageId: message.messageId,
      },
    };
  });
  const registered = new Map(
    resources.map((resource) => [resource.id, structuredClone(resource)]),
  );
  if (registered.size !== resources.length)
    throw new Error("Duplicate Gmail resource");
  return {
    resources,
    operations: [
      {
        action: "gmail/message.read",
        resourceKind: "gmail.message",
        async execute(resource) {
          if (!isDeepStrictEqual(resource, registered.get(resource.id)))
            throw new PermissionDenied("Unknown Gmail binding");
          try {
            return await accounts.withAccessToken(
              {
                ownerId: resource.ownerId,
                connectionId: resource.target.connectionId!,
                provider: "google",
                subject: resource.target.subject!,
              },
              async (token) => {
                const response = await boundedFetch(
                  `https://gmail.googleapis.com/gmail/v1/users/me/messages/${resource.target.messageId}?format=metadata&metadataHeaders=Subject`,
                  {
                    headers: { authorization: `Bearer ${token}` },
                  },
                  request,
                );
                if (!response.ok) {
                  await response.body?.cancel();
                  throw new Error();
                }
                const value = await response.json();
                if (
                  value?.id !== resource.target.messageId ||
                  typeof value.snippet !== "string" ||
                  value.snippet.length > 16_384 ||
                  !Array.isArray(value.payload?.headers)
                )
                  throw new Error();
                const subject =
                  value.payload.headers.find(
                    (header: { name?: string } | null) =>
                      typeof header?.name === "string" &&
                      header.name.toLowerCase() === "subject",
                  )?.value ?? "";
                if (typeof subject !== "string" || subject.length > 8192)
                  throw new Error();
                return {
                  id: resource.target.messageId!,
                  subject,
                  snippet: value.snippet as string,
                };
              },
            );
          } catch {
            throw new Error("Gmail read failed");
          }
        },
      },
    ],
    async close() {},
  };
}
