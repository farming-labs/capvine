import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Peer } from "./ipc.ts";

export async function runDemo(
  workerCount = 3,
  report: (line: string) => void = console.log,
) {
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8)
    throw new Error("Choose 1–8 workers");
  const directory = await mkdtemp(join(tmpdir(), "capvine-network-"));
  const peers: Peer[] = [];
  const start = (entry: string, env: Record<string, string> = {}) => {
    const peer = new Peer(new URL(entry, import.meta.url), env);
    peers.push(peer);
    return peer;
  };
  try {
    const authority = start("./authority.ts", {
      CAPVINE_DEMO_DB: join(directory, "state.db"),
    });
    const coordinator = start("./worker.ts");
    const workers = Array.from({ length: workerCount }, () =>
      start("./worker.ts"),
    );
    const info = await authority.request<{
      url: string;
      service: string;
      providerUrl: string;
      pid: number;
    }>("info");
    const coordinatorInfo = await coordinator.request<{
      did: string;
      pid: number;
    }>("info");
    const workerInfo = await Promise.all(
      workers.map((worker) =>
        worker.request<{ did: string; pid: number; environmentKeys: string[] }>(
          "info",
        ),
      ),
    );
    const pids = new Set([
      process.pid,
      info.pid,
      coordinatorInfo.pid,
      ...workerInfo.map(({ pid }) => pid),
    ]);
    assert.equal(pids.size, workerCount + 3);
    for (const worker of workerInfo) {
      assert.equal(worker.environmentKeys.includes("CAPVINE_DEMO_DB"), false);
      assert.equal(worker.environmentKeys.includes("GITHUB_TOKEN"), false);
    }
    await Promise.all(
      [coordinator, ...workers].map((worker) =>
        worker.request("connect", { url: info.url, service: info.service }),
      ),
    );
    report(
      `Started authority, coordinator, and ${workerCount} workers in separate processes.`,
    );
    report(
      "Provider data is simulated. Worker keys are created inside each worker; provider credentials stay in the authority.",
    );

    const assignments = await Promise.all(
      workers.map(async (_worker, index) => {
        const issue = 42 + index;
        const root = await authority.request<{
          grant: string;
          grantId: string;
        }>("issue", { issue, audience: coordinatorInfo.did });
        const child = await coordinator.request<{ grant: string }>("delegate", {
          grant: root.grant,
          audience: workerInfo[index]!.did,
        });
        return { issue, rootId: root.grantId, grant: child.grant };
      }),
    );
    report(
      `Owner policy issued ${workerCount} exact grants; coordinator delegated one to each worker.`,
    );
    const initial = await Promise.all(
      workers.map((worker, index) =>
        worker.request<{ status: string; value: { number: number } }>("read", {
          grant: assignments[index]!.grant,
        }),
      ),
    );
    for (let index = 0; index < initial.length; index++) {
      assert.equal(initial[index]!.status, "allowed");
      assert.equal(initial[index]!.value.number, assignments[index]!.issue);
      report(
        `ALLOW worker ${index + 1}: read issue ${assignments[index]!.issue}`,
      );
    }
    const first = workers[0]!;
    const grant = assignments[0]!.grant;
    for (const [label, override] of [
      ["read another issue", { resource: "urn:capvine:resource:issue-43" }],
      ["post a comment", { action: "github/comment.post" }],
      ["switch task", { task: "another-task" }],
    ] as const) {
      assert.equal(
        (
          await first.request<{ status: string }>("attempt", {
            grant,
            ...override,
          })
        ).status,
        "denied",
      );
      report(`DENY worker 1: ${label}`);
    }
    assert.equal(
      (
        await first.request<{ status: number }>("direct-provider", {
          url: `${info.providerUrl}/issues/42`,
        })
      ).status,
      401,
    );
    report("DENY direct provider access: worker has no provider credential");
    assert.equal((await fetch(new URL("/admin/issue", info.url))).status, 404);
    report(
      "DENY HTTP administration: no owner endpoints are exposed to workers",
    );

    await authority.request("revoke", { grantId: assignments[0]!.rootId });
    assert.equal(
      (await first.request<{ status: string }>("read", { grant })).status,
      "denied",
    );
    report("DENY worker 1 after revoking its parent grant");
    for (let index = 1; index < workers.length; index++) {
      assert.equal(
        (
          await workers[index]!.request<{ status: string }>("read", {
            grant: assignments[index]!.grant,
          })
        ).status,
        "allowed",
      );
      report(`ALLOW worker ${index + 1}: its independent grant still works`);
    }
    await authority.request("end-task");
    for (let index = 0; index < workers.length; index++) {
      assert.equal(
        (
          await workers[index]!.request<{ status: string }>("read", {
            grant: assignments[index]!.grant,
          })
        ).status,
        "denied",
      );
    }
    report("DENY all workers after the task ends");
    const stats = await authority.request<{
      providerReads: string[];
      unauthorizedProviderCalls: number;
      audit: string[];
    }>("stats");
    assert.deepEqual(
      [...stats.providerReads].sort(),
      [
        ...assignments.map(({ issue }) => String(issue)),
        ...assignments.slice(1).map(({ issue }) => String(issue)),
      ].sort(),
    );
    assert.equal(stats.unauthorizedProviderCalls, 1);
    report(
      `Verified ${stats.providerReads.length} authorized provider reads; rejected capability calls never reached the provider.`,
    );
    return {
      workerCount,
      processCount: pids.size,
      authorizedReads: stats.providerReads.length,
      auditEvents: stats.audit.length,
    };
  } finally {
    await Promise.all(peers.map((peer) => peer.close()));
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--workers"))
    throw new Error("Usage: npm run example:network -- --workers 3");
  await runDemo(args.length ? Number(args[1]) : 3);
}
