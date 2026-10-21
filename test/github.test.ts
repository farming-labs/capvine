import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubConnector } from "../src/github.ts";
import { PermissionDenied } from "../src/index.ts";

test("GitHub connector pins provider IDs and keeps credentials in fixed-origin requests", async () => {
  let repositoryId = 101;
  let issueId = 202;
  const calls: { url: string; authorization: string | null }[] = [];
  const connector = createGitHubConnector({
    connectionId: "github",
    token: "fixture-secret",
    fetch: async (input, init) => {
      const url = String(input);
      assert.equal(new URL(url).origin, "https://api.github.com");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.method, "GET");
      assert.ok(init?.signal);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json(
        url.endsWith("/issues/3")
          ? {
              id: issueId,
              number: 3,
              title: "Bound issue",
              body: "Content",
              state: "open",
              repository_url: "https://api.github.com/repos/example/project",
            }
          : { id: repositoryId },
      );
    },
  });
  const resource = await connector.resolveIssue({
    id: "urn:capvine:resource:issue",
    ownerId: "owner",
    owner: "example",
    repository: "project",
    number: 3,
  });
  assert.deepEqual(await connector.operation.execute(resource), {
    id: "202",
    repositoryId: "101",
    number: "3",
    title: "Bound issue",
    body: "Content",
    state: "open",
  });
  assert.ok(
    calls.every((call) => call.authorization === "Bearer fixture-secret"),
  );
  assert.ok(!JSON.stringify(resource).includes("fixture-secret"));
  repositoryId = 999;
  const before = calls.length;
  await assert.rejects(connector.operation.execute(resource), PermissionDenied);
  assert.equal(calls.length, before + 1);
  repositoryId = 101;
  issueId = 999;
  await assert.rejects(connector.operation.execute(resource), PermissionDenied);
  await assert.rejects(
    connector.operation.execute({
      ...resource,
      target: { ...resource.target, connection: "other" },
    }),
    PermissionDenied,
  );
});

test("GitHub connector rejects path tricks, oversized results, and unexpected provider responses", async () => {
  let calls = 0;
  const connector = createGitHubConnector({
    connectionId: "public",
    fetch: async () => {
      calls++;
      return new Response("x".repeat(1_048_700));
    },
  });
  for (const repository of [
    "..",
    "../private",
    "project?token=secret",
    "https://other.example",
  ]) {
    await assert.rejects(
      connector.resolveIssue({
        id: "urn:capvine:resource:x",
        ownerId: "owner",
        owner: "example",
        repository,
        number: 3,
      }),
      /target/,
    );
  }
  assert.equal(calls, 0);
  await assert.rejects(
    connector.resolveIssue({
      id: "urn:capvine:resource:x",
      ownerId: "owner",
      owner: "example",
      repository: "project",
      number: 3,
    }),
    /too large/,
  );
  const error = createGitHubConnector({
    connectionId: "private",
    fetch: async () => new Response("provider-secret", { status: 403 }),
  });
  await assert.rejects(
    error.resolveIssue({
      id: "urn:capvine:resource:x",
      ownerId: "owner",
      owner: "example",
      repository: "project",
      number: 3,
    }),
    { message: "GitHub read returned HTTP 403" },
  );
});
