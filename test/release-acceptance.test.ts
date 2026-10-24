import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptanceTemplate,
  checkAcceptance,
  gates,
} from "../examples/release/acceptance.ts";

test("release records require every gate, exact revision and matching evidence; templates never establish acceptance", async (t) => {
  const candidate = "a".repeat(40);
  const empty = await checkAcceptance(acceptanceTemplate(candidate), candidate);
  assert.equal(empty.recordsComplete, false);
  assert.ok(empty.gates.every((row) => row.status === "missing"));
  await assert.rejects(
    checkAcceptance(acceptanceTemplate(candidate), "b".repeat(40)),
    /revision/,
  );
  const directory = await mkdtemp(join(tmpdir(), "capvine-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records: Record<string, unknown> = {};
  for (const gate of gates) {
    const content = `Synthetic test evidence for ${gate}; not an actual review.`;
    const artifact = join(directory, gate + ".txt");
    await writeFile(artifact, content);
    records[gate] = {
      status: "accepted",
      revision: candidate,
      recordedAt: new Date().toISOString(),
      recordedBy: "Fixture reviewer",
      artifact,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }
  const document = { version: 1, candidate, records };
  assert.equal(
    (await checkAcceptance(document, candidate)).recordsComplete,
    true,
  );
  await writeFile(join(directory, gates[0] + ".txt"), "Replaced report");
  const changed = await checkAcceptance(document, candidate);
  assert.equal(changed.recordsComplete, false);
  assert.equal(changed.gates[0]?.status, "invalid");
  records[gates[1]] = {
    ...(records[gates[1]] as object),
    revision: "b".repeat(40),
  };
  records[gates[2]] = { ...(records[gates[2]] as object), recordedBy: "" };
  const invalid = await checkAcceptance(document, candidate);
  assert.equal(invalid.gates[1]?.status, "invalid");
  assert.equal(invalid.gates[2]?.status, "invalid");
  delete records[gates[3]];
  await assert.rejects(checkAcceptance(document, candidate), /explicit/);
});
