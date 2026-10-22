import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { request } from "node:http";
import { startPlayground } from "../examples/delegation-playground/server.ts";
import type { State } from "../examples/delegation-playground/scenario.ts";

async function setup(t: TestContext) {
  const app = await startPlayground({ port: 0 });
  t.after(() => app.close());
  const page = await fetch(app.url);
  const html = await page.text();
  const csrf = /name="csrf" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${app.url}/api/action`, {
      method: "POST",
      headers: {
        origin: app.url,
        "content-type": "application/json",
        "x-playground-csrf": csrf,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const action = async (name: string) => {
    const response = await post({ action: name });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as State;
  };
  const state = async () =>
    (await (await fetch(`${app.url}/api/state`)).json()) as State;
  return { ...app, page, html, post, action, state };
}

test("playground delegates between real processes and rejected signed requests never reach the provider", async (t) => {
  const f = await setup(t);
  const initial = await f.state();
  assert.equal(
    new Set([
      initial.authorityPid,
      initial.coordinator.pid,
      initial.worker.pid,
      initial.otherWorker.pid,
    ]).size,
    4,
  );
  assert.equal(
    new Set([
      initial.coordinator.did,
      initial.worker.did,
      initial.otherWorker.did,
    ]).size,
    3,
  );
  assert.deepEqual(initial.events, []);
  assert.equal((await f.post({ action: "delegate" })).status, 409);
  const approved = await f.action("approve");
  assert.ok(approved.root);
  assert.equal(approved.providerReads, 0);
  assert.equal((await f.post({ action: "approve" })).status, 409);
  const delegated = await f.action("delegate");
  assert.ok(delegated.child);
  assert.notEqual(delegated.child.id, delegated.root!.id);
  assert.ok(
    Date.parse(delegated.child.expiresAt) <=
      Date.parse(delegated.root!.expiresAt),
  );
  const allowed = await f.action("read");
  assert.equal(allowed.providerReads, 1);
  assert.deepEqual(allowed.events.at(-1)?.result, {
    number: 42,
    title: "Fixture issue 42",
    body: "A simulated provider response; no real account is connected.",
  });
  assert.deepEqual(allowed.events.at(-1)?.authorization, ["allowed"]);
  for (const attack of [
    "other-resource",
    "write",
    "other-worker",
    "expired",
    "direct-provider",
  ]) {
    const denied = await f.action(attack);
    const event = denied.events.at(-1)!;
    assert.equal(event.outcome, "denied", attack);
    assert.equal(event.expected, true, attack);
    assert.equal(event.providerDelta, 0, attack);
    assert.equal(denied.providerReads, 1, attack);
    assert.deepEqual(
      event.authorization,
      attack === "direct-provider" ? [] : ["denied"],
      attack,
    );
  }
  assert.equal((await f.state()).unauthorizedProviderCalls, 1);
  assert.equal((await f.action("read")).providerReads, 2);
  await f.action("revoke");
  const revoked = await f.action("read");
  assert.equal(revoked.events.at(-1)?.outcome, "denied");
  assert.deepEqual(revoked.events.at(-1)?.authorization, ["denied"]);
  assert.equal(revoked.providerReads, 2);
  assert.ok(revoked.events.every((event) => event.expected));
  const reset = await f.action("reset");
  assert.notEqual(reset.worker.did, initial.worker.did);
  assert.equal(reset.root, null);
  assert.equal(reset.child, null);
  assert.equal(reset.providerReads, 0);
  assert.deepEqual(reset.events, []);
  await f.action("approve");
  await f.action("delegate");
  await f.action("end-task");
  const ended = await f.action("read");
  assert.equal(ended.events.at(-1)?.outcome, "denied");
  assert.deepEqual(ended.events.at(-1)?.authorization, ["denied"]);
  assert.equal(ended.providerReads, 0);
  assert.ok(ended.events.every((event) => event.expected));
});

test("playground browser controls reject cross-origin requests and arbitrary commands without changing grants", async (t) => {
  const f = await setup(t);
  const before = await f.state();
  assert.match(
    f.page.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  assert.equal(f.page.headers.get("cache-control"), "no-store");
  for (const headers of [
    { origin: "https://attacker.example" },
    { origin: "null" },
    { origin: "" },
    { "x-playground-csrf": "" },
    { "x-playground-csrf": "wrong" },
    { "sec-fetch-site": "cross-site" },
  ])
    assert.equal((await f.post({ action: "approve" }, headers)).status, 403);
  assert.equal(
    (await f.post({ action: "approve" }, { "content-type": "text/plain" }))
      .status,
    415,
  );
  for (const body of [
    null,
    [],
    {},
    { action: "issue" },
    { action: "approve", resource: "other" },
    { action: "approve", url: "https://example.com" },
  ])
    assert.equal((await f.post(body)).status, 400);
  const badHost = await new Promise<number>((resolve, reject) => {
    const req = request(
      f.url,
      { headers: { host: "attacker.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHost, 403);
  assert.equal(
    (
      await fetch(`${f.url}/api/state`, {
        headers: { origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${f.url}/issue`)).status, 404);
  assert.deepEqual(await f.state(), before);
  const approved = await f.action("approve");
  assert.deepEqual(Object.keys(approved.root!).sort(), ["expiresAt", "id"]);
  assert.deepEqual(Object.keys(approved.worker).sort(), ["did", "pid"]);
  assert.equal((await fetch(`${f.url}/app.js`)).status, 200);
  assert.equal((await fetch(`${f.url}/style.css`)).status, 200);
});
