export { ed25519 as identity } from "@ucanto/principal";
export { createClient } from "./client.ts";
export { createAuthority } from "./server.ts";
export { MemoryStore } from "./memory.ts";
export { encodeGrant, decodeGrant } from "./profile.ts";
export { PermissionDenied } from "./types.ts";
export type {
  ResourceId,
  Identity,
  Principal,
  Grant,
  Json,
  Resource,
  Task,
  GrantRecord,
  AuditEvent,
  StateStore,
  Operation,
  GrantDecision,
} from "./types.ts";
