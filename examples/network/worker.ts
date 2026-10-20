import * as Ucanto from "@ucanto/client";
import {
  createClient,
  decodeGrant,
  encodeGrant,
  identity,
  PermissionDenied,
  type Json,
} from "../../src/index.ts";
import { createHttpTransport } from "../../src/http.ts";
import { serveIpc } from "./ipc.ts";

if (!process.send) throw new Error("Start this worker through demo.ts");
const signer = await identity.generate();
let client: ReturnType<typeof createClient> | undefined;
let transport: ReturnType<typeof createHttpTransport> | undefined;
let service: ReturnType<typeof identity.Verifier.parse> | undefined;

serveIpc(
  async ({ method, params }) => {
    if (method === "info")
      return {
        did: signer.did(),
        pid: process.pid,
        environmentKeys: Object.keys(process.env),
      };
    if (method === "connect") {
      if (typeof params.url !== "string" || typeof params.service !== "string")
        throw new Error("Invalid connection");
      service = identity.Verifier.parse(params.service as `did:key:${string}`);
      transport = createHttpTransport({ url: params.url });
      client = createClient({ signer, service, transport });
      return { connected: true };
    }
    if (method === "direct-provider") {
      if (typeof params.url !== "string")
        throw new Error("Missing fixture URL");
      const response = await fetch(params.url, {
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      return { status: response.status };
    }
    if (!client || !transport || !service || typeof params.grant !== "string")
      throw new Error("Worker is not configured");
    const grant = await decodeGrant(Buffer.from(params.grant, "base64"));
    if (method === "delegate") {
      if (typeof params.audience !== "string")
        throw new Error("Missing recipient");
      const audience = identity.Verifier.parse(
        params.audience as `did:key:${string}`,
      );
      const child = await client.delegate({
        grant,
        audience,
        expiresAt: new Date(Date.now() + 300_000),
      });
      return {
        grant: Buffer.from(await encodeGrant(child)).toString("base64"),
      };
    }
    try {
      if (method === "read")
        return { status: "allowed", value: await client.invoke(grant) };
      if (method === "attempt") {
        const original = grant.capabilities[0]!;
        const capability = {
          ...original,
          nb: { ...(original.nb as Record<string, Json>) },
        };
        if (typeof params.resource === "string")
          capability.with = params.resource as `urn:${string}`;
        if (typeof params.action === "string")
          capability.nb.action = params.action;
        if (typeof params.task === "string") capability.nb.task = params.task;
        const invocation = await Ucanto.invoke({
          issuer: signer,
          audience: service,
          capability,
          proofs: [grant],
          expiration: Math.min(
            grant.expiration,
            Math.floor(Date.now() / 1000) + 60,
          ),
          nonce: crypto.randomUUID(),
        }).delegate();
        return {
          status: "allowed",
          value: await transport(await encodeGrant(invocation)),
        };
      }
      throw new Error("Unknown worker command");
    } catch (error) {
      if (error instanceof PermissionDenied) return { status: "denied" };
      throw error;
    }
  },
  async () => {},
);
