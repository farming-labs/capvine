import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isDeepStrictEqual } from "node:util";
import type { ResourceAdapter } from "./adapter.ts";
import { PermissionDenied, type Json, type ResourceId } from "./types.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Executor response");
  return value as Record<string, unknown>;
}

export async function createExecutorGmailAdapter(options: {
  url: string;
  token: string;
  app: string;
  connectionId: string;
  ownerId: string;
  messages: {
    id: ResourceId;
    accountId: string;
    subject: string;
    messageId: string;
  }[];
}): Promise<ResourceAdapter> {
  const url = new URL(options.url);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.hash ||
    !options.token ||
    /[\r\n]/.test(options.token) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(options.app) ||
    !options.connectionId ||
    !options.ownerId ||
    options.messages.length === 0 ||
    options.messages.length > 256
  )
    throw new Error("Invalid Executor configuration");
  const path = `tools[${JSON.stringify(options.app)}].readMessage`;
  const resources = options.messages.map((message) => {
    if (
      !message.id.startsWith("urn:capvine:resource:") ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(message.accountId) ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(message.subject) ||
      !/^[a-fA-F0-9]{1,128}$/.test(message.messageId)
    )
      throw new Error("Invalid Gmail binding");
    return {
      id: message.id,
      ownerId: options.ownerId,
      kind: "gmail.message",
      target: {
        connectionId: options.connectionId,
        endpoint: url.href,
        tool: path,
        accountId: message.accountId,
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
  const client = new Client({ name: "capvine-executor", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${options.token}` } },
    fetch: async (input, init) => {
      if (
        new URL(input instanceof Request ? input.url : String(input)).href !==
        url.href
      )
        throw new Error("Unexpected Executor destination");
      const response = await fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(15_000),
        ]),
      });
      if (!response.body) return response;
      let size = 0;
      return new Response(
        response.body.pipeThrough(
          new TransformStream({
            transform(chunk: Uint8Array, controller) {
              size += chunk.byteLength;
              if (size > 1_048_576)
                throw new Error("Executor response is too large");
              controller.enqueue(chunk);
            },
          }),
        ),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    },
  });
  try {
    // The SDK's concrete transport declarations include explicit undefined optional properties.
    await client.connect(transport as Transport);
  } catch {
    await client.close().catch(() => {});
    throw new Error("Executor connection failed");
  }
  return {
    resources,
    operations: [
      {
        action: "gmail/message.read",
        resourceKind: "gmail.message",
        async execute(resource): Promise<Json> {
          if (!isDeepStrictEqual(resource, registered.get(resource.id)))
            throw new PermissionDenied("Unknown Gmail binding");
          const { accountId, subject, messageId } = resource.target;
          try {
            const reply = await client.callTool(
              {
                name: "call",
                arguments: {
                  calls: { path, input: { accountId, subject, messageId } },
                },
              },
              undefined,
              { timeout: 15_000 },
            );
            if (reply.isError) throw new Error();
            const result = record(reply.structuredContent);
            const execution = record(result.execution);
            const call = record(execution.value);
            if (
              result.status !== "completed" ||
              execution.ok !== true ||
              call.ok !== true ||
              call.path !== path
            )
              throw new Error();
            const value = record(call.value);
            const message = record(value.message);
            if (
              value.protocol !== "capvine.gmail.read.v1" ||
              value.accountId !== accountId ||
              value.subject !== subject ||
              value.messageId !== messageId ||
              message.id !== messageId ||
              typeof message.subject !== "string" ||
              typeof message.snippet !== "string" ||
              message.subject.length > 8192 ||
              message.snippet.length > 16_384
            )
              throw new Error();
            return {
              id: messageId!,
              subject: message.subject,
              snippet: message.snippet,
            };
          } catch {
            throw new Error("Executor Gmail read failed");
          }
        },
      },
    ],
    close: () => client.close(),
  };
}
