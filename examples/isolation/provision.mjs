import { randomBytes } from "node:crypto";
import { chmod, chown, writeFile } from "node:fs/promises";
import { createAuthority, encodeGrant, identity } from "../../dist/index.js";
import { SqliteStore } from "../../dist/sqlite.js";

const authority = await identity.generate();
const worker = await identity.generate();
const token = randomBytes(32).toString("base64url");
const resource = {
  id: "urn:capvine:resource:fixture",
  ownerId: "fixture-owner",
  kind: "fixture.record",
  target: { id: "fixed" },
};
const task = { id: "fixture-job", ownerId: "fixture-owner", active: true };
await writeFile("/authority/state.db", "", { flag: "wx", mode: 0o600 });
const store = new SqliteStore("/authority/state.db");
store.bindService(authority.did(), "fixture-owner");
store.addResource(resource);
store.addTask(task);
const issuer = createAuthority({
  signer: authority,
  store,
  authorizeGrant: ({ actor }) => actor === "fixture-owner",
});
issuer.registerOperation({
  action: "fixture/read",
  resourceKind: resource.kind,
  execute: async () => null,
});
const grant = await issuer.issue({
  actor: "fixture-owner",
  audience: worker,
  taskId: task.id,
  resource: resource.id,
  action: "fixture/read",
  expiresAt: new Date(Date.now() + 900_000),
});
const encoded = Buffer.from(await encodeGrant(grant)).toString("base64");
const root = store.getGrant(grant.cid.toString());
store.close();
await chown("/authority/state.db", 10001, 10000);
for (const [directory, uid, config] of [
  [
    "/authority",
    10001,
    {
      signer: identity.format(authority),
      token,
      resource,
      task,
      root,
    },
  ],
  ["/provider", 10003, { token }],
  [
    "/worker",
    10002,
    {
      signer: identity.format(worker),
      service: authority.did(),
      grant: encoded,
    },
  ],
]) {
  await writeFile(`${directory}/config.json`, JSON.stringify(config), {
    flag: "wx",
    mode: 0o600,
  });
  await chown(`${directory}/config.json`, uid, 10000);
  await chmod(directory, 0o700);
  await chown(directory, uid, 10000);
}
await chmod("/socket", 0o750);
await chown("/socket", 10001, 10000);
