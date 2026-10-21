import { randomBytes } from "node:crypto";
import { chmod, chown, writeFile } from "node:fs/promises";
import {
  createAuthority,
  encodeGrant,
  identity,
  MemoryStore,
} from "../../dist/index.js";

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
const store = new MemoryStore();
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
for (const [directory, uid, config] of [
  [
    "/authority",
    10001,
    {
      signer: identity.format(authority),
      token,
      resource,
      task,
      root: store.getGrant(grant.cid.toString()),
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
