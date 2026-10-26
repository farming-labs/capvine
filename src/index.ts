export { ed25519 as identity } from "@ucanto/principal";
export { createClient } from "./client.ts";
export { createAuthority } from "./server.ts";
export { MemoryStore } from "./memory.ts";
export { encodeGrant, decodeGrant } from "./profile.ts";
export { PermissionDenied } from "./types.ts";
export { createPermissionInspector } from "./inspection.ts";
export type {
  InspectionQuery,
  InspectionStore,
  AuditPosition,
  InspectedGrant,
  InspectedOutcome,
  GrantPage,
  AuditPage,
} from "./inspection.ts";
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
