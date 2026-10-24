import { isDeepStrictEqual } from "node:util";
import { defineResource } from "../../src/resources.ts";
import { PermissionDenied, type ResourceId } from "../../src/types.ts";

export function messages(options: {
  origin: string;
  provider: string;
  connectionId: string;
  subject: string;
  messages: { id: ResourceId; messageId: string }[];
  allowLoopbackHttp?: boolean;
}) {
  const settings = structuredClone(options);
  const origin = new URL(settings.origin);
  if (
    origin.origin !== settings.origin ||
    (origin.protocol !== "https:" &&
      !(
        settings.allowLoopbackHttp &&
        origin.protocol === "http:" &&
        origin.hostname === "127.0.0.1"
      )) ||
    !settings.messages.length ||
    settings.messages.length > 32 ||
    settings.messages.some(
      (message) => !/^[a-f0-9]{1,128}$/.test(message.messageId),
    )
  )
    throw new Error("Invalid message plugin configuration");
  return defineResource({
    name: "example-messages",
    open({ accounts, ownerId }) {
      if (!accounts) throw new Error("Messages require an account provider");
      const connection = accounts.inspect(ownerId, settings.connectionId);
      if (
        connection.status !== "connected" ||
        connection.provider !== settings.provider ||
        connection.subject !== settings.subject
      )
        throw new Error(
          "Connect the selected account before registering messages",
        );
      const resources = settings.messages.map((message) => ({
        id: message.id,
        ownerId,
        kind: "example.message",
        target: {
          origin: settings.origin,
          connectionId: settings.connectionId,
          provider: settings.provider,
          subject: settings.subject,
          messageId: message.messageId,
        },
      }));
      const bindings = new Map(
        resources.map((resource) => [resource.id, structuredClone(resource)]),
      );
      return {
        resources,
        operations: [
          {
            action: "example/message.read",
            resourceKind: "example.message",
            async execute(resource) {
              if (!isDeepStrictEqual(resource, bindings.get(resource.id)))
                throw new PermissionDenied("Unknown message binding");
              return accounts.withAccessToken(
                {
                  ownerId,
                  connectionId: resource.target.connectionId!,
                  provider: resource.target.provider!,
                  subject: resource.target.subject!,
                },
                async (token) => {
                  const response = await fetch(
                    `${resource.target.origin}/messages/${resource.target.messageId}`,
                    {
                      headers: { authorization: `Bearer ${token}` },
                      redirect: "error",
                      signal: AbortSignal.timeout(5000),
                    },
                  );
                  if (!response.ok || !response.body) {
                    await response.body?.cancel();
                    throw new Error("Message unavailable");
                  }
                  const reader = response.body.getReader();
                  const chunks: Uint8Array[] = [];
                  let size = 0;
                  try {
                    for (;;) {
                      const chunk = await reader.read();
                      if (chunk.done) break;
                      size += chunk.value.length;
                      if (size > 32_768)
                        throw new Error("Message response too large");
                      chunks.push(chunk.value);
                    }
                  } finally {
                    await reader.cancel();
                    reader.releaseLock();
                  }
                  const value = JSON.parse(
                    Buffer.concat(chunks).toString("utf8"),
                  );
                  if (
                    value?.id !== resource.target.messageId ||
                    typeof value.snippet !== "string" ||
                    value.snippet.length > 16_384
                  )
                    throw new Error("Unexpected message response");
                  return {
                    id: value.id as string,
                    snippet: value.snippet as string,
                  };
                },
              );
            },
          },
        ],
        async close() {},
      };
    },
  });
}
