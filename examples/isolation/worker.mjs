import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { invoke } from "@ucanto/client";
import { ed25519 } from "@ucanto/principal";
import {
  createClient,
  decodeGrant,
  encodeGrant,
  identity,
  PermissionDenied,
} from "../../dist/index.js";

const config = JSON.parse(await readFile("/worker/config.json", "utf8"));
const signer = identity.parse(config.signer);
const service = ed25519.Verifier.parse(config.service);
const grant = await decodeGrant(Buffer.from(config.grant, "base64"));
const transport = (bytes) =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath: "/socket/invoke.sock",
        path: "/invoke",
        method: "POST",
        headers: {
          "content-type": "application/vnd.ipld.car",
          "content-length": bytes.length,
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4096)
            response.destroy(new Error("Oversized fixture response"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode === 403) {
            reject(new PermissionDenied("Denied"));
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error("Invocation failed"));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")).ok);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.setTimeout(5000, () =>
      outgoing.destroy(new Error("Invocation timed out")),
    );
    outgoing.on("error", reject);
    outgoing.end(bytes);
  });
const client = createClient({ signer, service, transport });
const denied = process.argv[2] === "--expect-denied";
if (denied) await assert.rejects(client.invoke(grant), PermissionDenied);
else
  assert.deepEqual(await client.invoke(grant), {
    id: "fixed",
    title: "Isolated provider result",
  });
const forged = await invoke({
  issuer: signer,
  audience: service,
  capability: { ...grant.capabilities[0], with: "urn:capvine:resource:other" },
  proofs: [grant],
  expiration: grant.expiration,
}).delegate();
await assert.rejects(transport(await encodeGrant(forged)), PermissionDenied);
for (const path of [
  "/authority/config.json",
  "/authority/state.db",
  "/provider/config.json",
  "/var/run/docker.sock",
])
  await assert.rejects(readFile(path));
await assert.rejects(writeFile("/app/modified", "tamper"));
await assert.rejects(writeFile("/worker/config.json", "tamper"));
assert.equal(
  Object.values(networkInterfaces())
    .flat()
    .some((entry) => entry && !entry.internal),
  false,
);
await assert.rejects(
  fetch("http://provider:8080/records/fixed", {
    signal: AbortSignal.timeout(2000),
  }),
);
await assert.rejects(
  new Promise((resolve, reject) => {
    const socket = connect({ host: "1.1.1.1", port: 443 });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.setTimeout(2000, () =>
      socket.destroy(new Error("Network unreachable")),
    );
  }),
);
console.log(
  `${denied ? "Revoked invocation rejected" : "Allowed invocation passed"}; escalation, credential access, filesystem tampering, provider bypass, and external network access were rejected.`,
);
