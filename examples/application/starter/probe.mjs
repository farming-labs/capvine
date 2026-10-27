import { invoke } from "@ucanto/client";
import { decodeGrant, encodeGrant, identity } from "@farming-labs/capvine";
import { readPrivateFile } from "@farming-labs/capvine/identity-file";
import { createHttpTransport } from "@farming-labs/capvine/http";

export async function probeResource(path, resource) {
  const assignment = JSON.parse(await readPrivateFile(path, 65_536));
  const grant = await decodeGrant(Buffer.from(assignment.grant, "base64"));
  const original = grant.capabilities[0];
  const request = await invoke({
    issuer: identity.parse(assignment.signer),
    audience: identity.Verifier.parse(original.nb.service),
    capability: { ...original, with: resource },
    proofs: [grant],
    expiration: Math.min(grant.expiration, Math.floor(Date.now() / 1000) + 60),
    nonce: crypto.randomUUID(),
  }).delegate();
  return createHttpTransport({ url: assignment.url })(
    await encodeGrant(request),
  );
}
