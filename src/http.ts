import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import { PermissionDenied, type Json } from "./types.ts";

const contentType = "application/vnd.ipld.car";
const maxRequestBytes = 65_536;
const maxResponseBytes = 1_048_576;

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HttpTransportError extends Error {
  override name = "HttpTransportError";
  constructor(readonly status: number) {
    super(`Permission service returned HTTP ${status}`);
  }
}

function readRequest(request: IncomingMessage): Promise<Uint8Array> {
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

function respond(response: ServerResponse, status: number, value: Json): void {
  if (response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(JSON.stringify(value));
}

export function createHttpHandler(options: {
  execute: (invocation: Uint8Array) => Promise<Json>;
}): RequestListener {
  let active = 0;
  return (request, response) => {
    if (request.url !== "/invoke") {
      request.resume();
      respond(response, 404, { error: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      response.setHeader("allow", "POST");
      respond(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (request.headers.origin) {
      request.resume();
      respond(response, 403, { error: "browser_origin_not_supported" });
      return;
    }
    if (request.headers["content-type"] !== contentType) {
      request.resume();
      respond(response, 415, { error: "unsupported_media_type" });
      return;
    }
    if (Number(request.headers["content-length"] ?? 0) > maxRequestBytes) {
      request.resume();
      respond(response, 413, { error: "request_too_large" });
      return;
    }
    if (active >= 16) {
      request.resume();
      response.setHeader("retry-after", "1");
      respond(response, 429, { error: "busy" });
      return;
    }
    active++;
    void (async () => {
      try {
        const value = await options.execute(await readRequest(request));
        if (Buffer.byteLength(JSON.stringify(value)) > maxResponseBytes) {
          respond(response, 502, { error: "result_too_large" });
        } else {
          respond(response, 200, { ok: value });
        }
      } catch (error) {
        const status =
          error instanceof PermissionDenied
            ? 403
            : error instanceof RequestError
              ? error.status
              : 500;
        respond(response, status, {
          error: status === 403 ? "permission_denied" : "request_failed",
        });
      } finally {
        active--;
      }
    })();
  };
}

async function readResponse(response: Response): Promise<unknown> {
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

export function createHttpTransport(options: {
  url: string;
  timeoutMs?: number;
}) {
  const endpoint = new URL(options.url);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    endpoint.hostname,
  );
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && loopback)
  ) {
    throw new Error("Use HTTPS, or HTTP on loopback for local development");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Endpoint must not contain credentials or a fragment");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid timeout");
  return async (invocation: Uint8Array): Promise<Json> => {
    if (invocation.byteLength > maxRequestBytes)
      throw new Error("Invocation is too large");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Uint8Array(invocation),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403)
        throw new PermissionDenied("Permission service denied the invocation");
      throw new HttpTransportError(response.status);
    }
    const result = await readResponse(response);
    if (!result || typeof result !== "object" || !("ok" in result)) {
      throw new Error("Invalid permission service response");
    }
    return result.ok as Json;
  };
}
