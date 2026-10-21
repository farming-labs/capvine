import { chmod, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createAuthority, identity, MemoryStore } from "../../dist/index.js";
import { createHttpHandler } from "../../dist/http.js";

const config = JSON.parse(await readFile("/authority/config.json", "utf8"));
const store = new MemoryStore();
store.addResource(config.resource);
store.addTask(config.task);
store.addGrant(config.root);
const authority = createAuthority({
  signer: identity.parse(config.signer),
  store,
  authorizeGrant: () => false,
});
authority.registerOperation({
  action: "fixture/read",
  resourceKind: "fixture.record",
  execute: async (resource) => {
    if (resource.target.id !== "fixed")
      throw new Error("Unknown provider binding");
    const response = await fetch("http://provider:8080/records/fixed", {
      headers: { authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("Provider read failed");
    return response.json();
  },
});
const server = createServer(createHttpHandler({ execute: authority.execute }));
server.listen("/socket/invoke.sock", async () => {
  await chmod("/socket/invoke.sock", 0o660);
});
process.once("SIGTERM", () => server.close());
