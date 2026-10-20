import { delegate as issueDelegation, invoke } from "@ucanto/client";
import { expiry, readClaim, encodeGrant } from "./profile.ts";
import {
  PermissionDenied,
  type Grant,
  type Identity,
  type Principal,
  type Json,
} from "./types.ts";

export function createClient(options: {
  signer: Identity;
  service: Principal;
  transport: (invocation: Uint8Array) => Promise<Json>;
}) {
  return {
    async delegate(input: {
      grant: Grant;
      audience: Principal;
      expiresAt: Date;
    }): Promise<Grant> {
      const claim = readClaim(input.grant);
      const expiration = expiry(input.expiresAt);
      if (input.grant.audience.did() !== options.signer.did()) {
        throw new PermissionDenied("This grant was issued to another identity");
      }
      if (expiration > input.grant.expiration) {
        throw new PermissionDenied("A child cannot outlive its parent");
      }
      if (claim.service !== options.service.did()) {
        throw new PermissionDenied("This grant belongs to another service");
      }
      return issueDelegation({
        issuer: options.signer,
        audience: input.audience,
        capabilities: [input.grant.capabilities[0]!],
        proofs: [input.grant],
        expiration,
        nonce: crypto.randomUUID(),
      });
    },

    async invoke(grant: Grant): Promise<Json> {
      const claim = readClaim(grant);
      if (grant.audience.did() !== options.signer.did()) {
        throw new PermissionDenied("This grant was issued to another identity");
      }
      if (claim.service !== options.service.did()) {
        throw new PermissionDenied("This grant belongs to another service");
      }
      const invocation = await invoke({
        issuer: options.signer,
        audience: options.service,
        capability: grant.capabilities[0]!,
        proofs: [grant],
        expiration: Math.min(
          grant.expiration,
          Math.floor(Date.now() / 1000) + 60,
        ),
        nonce: crypto.randomUUID(),
      }).delegate();
      return options.transport(await encodeGrant(invocation));
    },
  };
}
