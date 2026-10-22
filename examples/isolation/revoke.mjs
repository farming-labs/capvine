import { open, readFile, unlink } from "node:fs/promises";
import { SqliteStore } from "../../dist/sqlite.js";
import { identity } from "../../dist/index.js";

const config = JSON.parse(await readFile("/authority/config.json", "utf8"));
const lock = await open("/authority/process.lock", "wx", 0o600);
const store = new SqliteStore("/authority/state.db");
try {
  store.bindService(identity.parse(config.signer).did(), "fixture-owner");
  store.revoke(config.root.id);
} finally {
  store.close();
  await lock.close();
  await unlink("/authority/process.lock");
}
console.log(
  "Fixture root revoked in persistent state while the authority was stopped.",
);
