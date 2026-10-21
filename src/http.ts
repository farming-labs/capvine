import type { IncomingMessage, ServerResponse } from "node:http";
import { PermissionDenied, type Json } from "./types.ts";
import {
  contentType,
  maxRequestBytes,
  maxResponseBytes,
  RequestError,
  readRequest,
  respond,
  readResponse,
} from "./http-internal.ts";

export class HttpTransportError extends Error {
  override name = "HttpTransportError";
  constructor(readonly status: number) {
    super(`Permission service returned HTTP ${status}`);
  }
}

export function createHttpHandler(options: {
  execute: (invocation: Uint8Array) => Promise<Json>;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let active = 0;
  return async (request, response) => {
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
  };
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
