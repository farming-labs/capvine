import type { IncomingMessage, ServerResponse } from "node:http";
import type { Json } from "./types.ts";

export const contentType = "application/vnd.ipld.car";
export const maxRequestBytes = 65_536;
export const maxResponseBytes = 1_048_576;

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function readRequest(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    let chunks: Buffer[] = [];
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      chunks = [];
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new RequestError(408, "Request timed out")),
      5_000,
    );
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > maxRequestBytes)
        fail(new RequestError(413, "Request too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    request.on("aborted", () => fail(new RequestError(400, "Request aborted")));
    request.on("error", () => fail(new RequestError(400, "Invalid request")));
  });
}

export function respond(
  response: ServerResponse,
  status: number,
  value: Json,
): void {
  if (response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(JSON.stringify(value));
}

export async function readResponse(response: Response): Promise<unknown> {
  if (
    Number(response.headers.get("content-length") ?? 0) >
    maxResponseBytes + 100
  ) {
    await response.body?.cancel();
    throw new Error("Permission service response is too large");
  }
  if (!response.body)
    throw new Error("Permission service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes + 100) {
        await reader.cancel();
        throw new Error("Permission service response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
