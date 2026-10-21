import { ed25519 } from "@ucanto/principal";
import { createClient, decodeGrant, identity } from "../src/index.ts";
import { createHttpTransport } from "../src/http.ts";
import { readPrivateFile } from "../src/identity-file.ts";

const path = process.argv[2];
if (!path) throw new Error("Private worker provisioning is required");
const config = JSON.parse(await readPrivateFile(path, 65_536));
const client = createClient({
  signer: identity.parse(config.signer),
  service: ed25519.Verifier.parse(config.service),
  transport: createHttpTransport({ url: config.url }),
});
const results = [];
for (const encoded of config.grants)
  results.push(
    await client.invoke(await decodeGrant(Buffer.from(encoded, "base64"))),
  );
console.log(JSON.stringify(results));
