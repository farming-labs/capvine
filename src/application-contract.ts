import type { Json, ResourceId } from "./types.ts";

export interface RegisterResourceInput {
  type: string;
  plugin?: string;
  connectionId?: string;
  target: Record<string, Json>;
}

export interface RegisteredResource {
  id: ResourceId;
  type: string;
  plugin: string;
  connectionId?: string;
  actions: string[];
}

export interface ConnectedAccount {
  id: string;
  ownerId: string;
  provider: string;
  status: "connecting" | "connected" | "disconnected" | "reconnect_required";
  subject: string | null;
  scopes: string[];
}

export interface IssuedGrant {
  id: string;
  grant: string;
  resource: ResourceId;
  action: string;
  audience: string;
  expiresAt: number;
  service: `did:key:${string}`;
  invocationURL: string;
}

export interface SavedWorkflow {
  id: string;
  resource: ResourceId;
  action: string;
  audience: string;
  expiresAt: number;
  maxGrantSeconds: number;
  active: boolean;
}

export interface ApplicationCommands {
  "connections/connect": {
    input: { provider: string; returnTo?: string };
    output: { connectionId: string; url: string };
  };
  "connections/list": {
    input: { after?: string };
    output: { connections: ConnectedAccount[]; nextCursor: string | null };
  };
  "connections/disconnect": {
    input: { connectionId: string };
    output: { disconnected: true };
  };
  "resources/register": {
    input: RegisterResourceInput;
    output: RegisteredResource;
  };
  "resources/list": {
    input: { after?: string };
    output: { resources: RegisteredResource[]; nextCursor: string | null };
  };
  "grants/issue": {
    input: {
      resource: ResourceId;
      action: string;
      audience: string;
      expiresIn?: number;
    };
    output: IssuedGrant;
  };
  "grants/revoke": { input: { id: string }; output: { revoked: true } };
  "workflows/approve": {
    input: {
      resource: ResourceId;
      action: string;
      audience: string;
      expiresIn: number;
      maxGrantSeconds?: number;
    };
    output: SavedWorkflow;
  };
  "workflows/list": {
    input: { after?: string };
    output: { workflows: SavedWorkflow[]; nextCursor: string | null };
  };
  "workflows/issue": { input: { id: string }; output: IssuedGrant };
  "workflows/disable": { input: { id: string }; output: { disabled: true } };
}

export type Command = keyof ApplicationCommands;
export type CommandInput<K extends Command> = ApplicationCommands[K]["input"];
export type CommandOutput<K extends Command> = ApplicationCommands[K]["output"];

export class CapvineAPIError extends Error {
  override name = "CapvineAPIError";
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function applicationURL(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "baseURL must be an HTTPS origin or a loopback HTTP origin",
    );
  return url;
}

export const basePath = "/api/capvine";

export async function readBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) throw new CapvineAPIError(400, "missing_body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CapvineAPIError(408, "request_timeout"));
      void reader.cancel().catch(() => {});
    }, 5000);
  });
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), timeout]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new CapvineAPIError(413, "body_too_large");
      }
      chunks.push(item.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CapvineAPIError(400, "invalid_input");
  const result = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new CapvineAPIError(400, "invalid_fields");
  return result;
}

export function string(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new CapvineAPIError(400, "invalid_string");
  return value;
}
