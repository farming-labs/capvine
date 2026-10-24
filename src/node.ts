import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { applicationURL } from "./application-contract.ts";

export function toNodeHandler(
  app: { handler(request: Request): Promise<Response> },
  options: { baseURL: string },
) {
  const origin = applicationURL(options.baseURL).origin;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value))
          for (const entry of value) headers.append(name, entry);
        else if (value !== undefined) headers.set(name, value);
      }
      const method = request.method ?? "GET";
      const input = new Request(new URL(request.url ?? "/", origin), {
        method,
        headers,
        ...(["GET", "HEAD"].includes(method)
          ? {}
          : {
              body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
              duplex: "half",
            }),
      } as RequestInit);
      const result = await app.handler(input);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body)
        await pipeline(
          Readable.fromWeb(
            result.body as Parameters<typeof Readable.fromWeb>[0],
          ),
          response,
        );
      else response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  };
}
