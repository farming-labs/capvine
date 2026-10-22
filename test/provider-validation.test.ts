import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccountManager } from "../src/accounts.ts";
import { createGmailAdapter } from "../src/gmail.ts";
import { createSlackAdapter } from "../src/slack.ts";
import { startProviderFixture } from "../examples/accounts/provider-fixture.ts";
import { startSlackFixture } from "../examples/slack/provider-fixture.ts";
import {
  checkProviderRead,
  checkProviderRejection,
} from "../examples/provider-validation/check.ts";

for (const kind of ["google", "slack"] as const) {
  test(`provider validation exercises ${kind} through a separate MCP worker without returning message data`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "capvine-validation-test-"));
    const fixture =
      kind === "google"
        ? await startProviderFixture()
        : await startSlackFixture();
    const options = {
      directory: join(directory, "accounts"),
      key: randomBytes(32),
      providers: [fixture.provider()],
    };
    const openAccounts = () => openAccountManager(options);
    t.after(async () => {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    });
    const accounts = await openAccounts();
    const sessionId = randomBytes(32).toString("base64url");
    let connected;
    try {
      const pending = await accounts.begin({
        ownerId: "owner",
        connectionId: "connection",
        provider: kind,
        sessionId,
      });
      connected = await accounts.complete({
        ownerId: "owner",
        sessionId,
        callback: await fixture.authorize(pending.url),
      });
    } finally {
      await accounts.close();
    }
    const binding = {
      id: "urn:capvine:resource:message" as const,
      connectionId: "connection",
      subject: connected.subject!,
    };
    const result = await checkProviderRead({
      ownerId: "owner",
      openAccounts,
      adapter: (accounts) =>
        "gmailFetch" in fixture
          ? createGmailAdapter({
              accounts,
              ownerId: "owner",
              messages: [{ ...binding, messageId: "a42" }],
              fetch: fixture.gmailFetch,
            })
          : createSlackAdapter({
              accounts,
              ownerId: "owner",
              messages: [
                {
                  ...binding,
                  channelId: "CFIXTURE",
                  timestamp: "1700000000.000042",
                },
              ],
              fetch: fixture.fetch,
            }),
    });
    assert.ok(Object.values(result).every((value) => value === true));
    assert.equal(fixture.counts.reads, 2);
    assert.equal(fixture.counts.refreshes, 1);
    const rejectOptions = {
      ownerId: "owner",
      connectionId: "connection",
      subject: connected.subject!,
      provider: kind,
      openAccounts,
    };
    await assert.rejects(
      checkProviderRejection(rejectOptions),
      /still accepts/,
    );
    fixture.revoke();
    const rejected = await checkProviderRejection(rejectOptions);
    assert.equal(rejected.newlyObservedRejection, true);
    assert.equal(rejected.reconnectRequiredAfterRestart, true);
    assert.equal(
      (await checkProviderRejection(rejectOptions)).newlyObservedRejection,
      false,
    );
    assert.equal(fixture.counts.reads, 2);
  });
}

test("provider rejection validation cannot report a temporary Slack outage as revoked consent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "capvine-validation-outage-"));
  const fixture = await startSlackFixture();
  fixture.controls.shortAccess = false;
  const options = {
    directory: join(directory, "accounts"),
    key: randomBytes(32),
    providers: [fixture.provider()],
  };
  const openAccounts = () => openAccountManager(options);
  t.after(async () => {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  const accounts = await openAccounts();
  const sessionId = randomBytes(32).toString("base64url");
  let connected;
  try {
    const pending = await accounts.begin({
      ownerId: "owner",
      connectionId: "connection",
      provider: "slack",
      sessionId,
    });
    connected = await accounts.complete({
      ownerId: "owner",
      sessionId,
      callback: await fixture.authorize(pending.url),
    });
  } finally {
    await accounts.close();
  }
  fixture.controls.authStatus = 503;
  await assert.rejects(
    checkProviderRejection({
      ownerId: "owner",
      connectionId: "connection",
      provider: "slack",
      subject: connected.subject!,
      openAccounts,
    }),
    /transient error/,
  );
  const reopened = await openAccounts();
  try {
    assert.equal(reopened.inspect("owner", "connection").status, "connected");
  } finally {
    await reopened.close();
  }
});
