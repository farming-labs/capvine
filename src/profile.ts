import { Delegation, type API } from "@ucanto/core";
import { capability, Schema, URI, DID, Failure } from "@ucanto/validator";
import { PermissionDenied, type Grant, type ResourceId } from "./types.ts";

const caveats = Schema.struct({
  action: Schema.string(),
  task: Schema.string(),
  service: DID.match({ method: "key" }),
});

export const operationCapability = capability({
  can: "capvine/invoke",
  with: URI.match({ protocol: "urn:" }),
  nb: caveats,
  derives: (claim, proof): API.Result<{}, API.Failure> =>
    claim.with === proof.with &&
    claim.nb.action === proof.nb.action &&
    claim.nb.task === proof.nb.task &&
    claim.nb.service === proof.nb.service
      ? { ok: {} }
      : {
          error: new Failure(
            "Delegation changed the resource, action, task, or service",
          ),
        },
});

export function readClaim(grant: Grant) {
  const raw = grant.capabilities[0];
  if (grant.capabilities.length !== 1 || raw?.can !== operationCapability.can) {
    throw new PermissionDenied("Expected one exact Capvine capability");
  }
  const parsed = caveats.read(raw.nb);
  if (parsed.error || !raw.with.startsWith("urn:capvine:resource:")) {
    throw new PermissionDenied("Invalid resource or capability restrictions");
  }
  return {
    resource: raw.with as ResourceId,
    action: parsed.ok.action,
    task: parsed.ok.task,
    service: parsed.ok.service,
  };
}

export function inspectChain(grant: Grant): Grant[] {
  const chain: Grant[] = [];
  let current = grant;
  for (;;) {
    if (chain.length >= 8)
      throw new PermissionDenied("Delegation chain is too deep");
    readClaim(current);
    if (!Number.isSafeInteger(current.expiration)) {
      throw new PermissionDenied("A finite expiry is required");
    }
    chain.push(current);
    if (current.proofs.length === 0) return chain;
    const parent = current.proofs[0];
    if (
      current.proofs.length !== 1 ||
      !parent ||
      !Delegation.isDelegation(parent)
    ) {
      throw new PermissionDenied("Expected one embedded parent proof");
    }
    if (current.expiration > parent.expiration) {
      throw new PermissionDenied("A child cannot outlive its parent");
    }
    current = parent;
  }
}

export function expiry(date: Date): number {
  const value = Math.floor(date.getTime() / 1000);
  if (!Number.isSafeInteger(value) || value <= Math.floor(Date.now() / 1000)) {
    throw new PermissionDenied("Expiry must be a future date");
  }
  return value;
}

export async function encodeGrant(grant: Grant): Promise<Uint8Array> {
  const result = await Delegation.archive(grant);
  if (result.error) throw result.error;
  return result.ok;
}

export async function decodeGrant(bytes: Uint8Array): Promise<Grant> {
  if (bytes.byteLength > 65_536)
    throw new PermissionDenied("Proof archive is too large");
  try {
    const result = await Delegation.extract(bytes);
    if (result.error) throw new PermissionDenied("Invalid proof archive");
    return result.ok;
  } catch {
    throw new PermissionDenied("Invalid proof archive");
  }
}

export function asInvocation(
  grant: Grant,
): API.Invocation<ReturnType<typeof operationCapability.create>> {
  readClaim(grant);
  return grant as API.Invocation<ReturnType<typeof operationCapability.create>>;
}
