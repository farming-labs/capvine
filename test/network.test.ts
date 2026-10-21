import assert from "node:assert/strict";
import { test } from "node:test";
import { runDemo } from "../examples/network/demo.ts";

test(
  "separate workers enforce assignments, revocation, and task termination across HTTP",
  { timeout: 45_000 },
  async () => {
    const lines: string[] = [];
    const result = await runDemo(3, (line) => lines.push(line));
    assert.deepEqual(result, {
      workerCount: 3,
      processCount: 6,
      authorizedReads: 5,
      auditEvents: 12,
    });
    assert.ok(lines.includes("DENY worker 1: read another issue"));
    assert.ok(
      lines.includes("ALLOW worker 2: its independent grant still works"),
    );
  },
);

test("the network demo validates worker count before starting child processes", async () => {
  for (const count of [0, 9, 1.5, Number.NaN])
    await assert.rejects(
      runDemo(count, () => {}),
      /Choose 1–8 workers/,
    );
});
