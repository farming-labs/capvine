import { ed25519 } from "@ucanto/principal";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../src/mcp.ts";
import { createHttpTransport } from "../src/http.ts";
import { decodeGrant, identity } from "../src/index.ts";
import { readPrivateFile } from "../src/identity-file.ts";

const path = process.argv[2];
if (!path) throw new Error("A private provisioning file is required");
const config = JSON.parse(await readPrivateFile(path));
const server = createMcpServer({
  signer: identity.parse(config.signer),
  service: ed25519.Verifier.parse(config.service),
  taskId: config.taskId,
  transport: createHttpTransport({ url: config.url }),
  tools: [
    {
      name: "read_assigned_record",
      grant: await decodeGrant(Buffer.from(config.grant, "base64")),
    },
  ],
});
await server.connect(new StdioServerTransport());
