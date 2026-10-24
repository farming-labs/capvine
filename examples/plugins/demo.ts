import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { invoke } from "@ucanto/client";
import { createCapvine, workflow } from "../../src/setup.ts";
import { oidc } from "../../src/providers.ts";
import { createHttpTransport } from "../../src/http.ts";
import {
  identity,
  decodeGrant,
  encodeGrant,
  PermissionDenied,
} from "../../src/index.ts";
import { startProviderFixture } from "../accounts/provider-fixture.ts";
import { messages } from "./message-resource.ts";

export async function runPluginExample() {
  const temporary = await mkdtemp(join(tmpdir(), "capvine-plugins-"));
  const fixture = await startProviderFixture({
    scopes: ["openid", "messages:read"],
  });
  const options = {
    directory: join(temporary, "app"),
    ownerId: "example-owner",
    providers: [oidc({ ...fixture.providerOptions(), id: "example" })],
    port: 0,
  };
  let app: Awaited<ReturnType<typeof createCapvine>> | undefined;
  const mcp = new Client({ name: "plugin-example", version: "0.0.0" });
  try {
    app = await createCapvine(options);
    const sessionId = randomBytes(32).toString("base64url");
    const pending = await app.accounts.begin({
      ownerId: options.ownerId,
      sessionId,
      connectionId: "example-account",
      provider: "example",
    });
    const connection = await app.accounts.complete({
      ownerId: options.ownerId,
      sessionId,
      callback: await fixture.authorize(pending.url),
    });
    const selected = "urn:capvine:resource:message" as const;
    const resources = [
      messages({
        origin: fixture.issuer,
        allowLoopbackHttp: true,
        provider: "example",
        connectionId: connection.id,
        subject: connection.subject!,
        messages: [{ id: selected, messageId: "a42" }],
      }),
    ];
    const workflows = [
      workflow({
        id: "read-message",
        resource: selected,
        action: "example/message.read",
      }),
    ];
    await app.start({ resources, workflows });
    const approval = await app.workflows.approve("read-message");
    const job = await app.workflows.provision(approval.id);
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
          "worker",
          job.path,
        ],
        env: {},
        stderr: "pipe",
      }),
    );
    const read = () => mcp.callTool({ name: "read_message" });
    const first = await read();
    assert.equal(first.isError, undefined);
    assert.deepEqual(first.content, [
      {
        type: "text",
        text: JSON.stringify({ id: "a42", snippet: "The report is ready." }),
      },
    ]);
    assert.equal(fixture.counts.refreshes, 1);
    const saved = JSON.parse(await readFile(job.path, "utf8"));
    const grant = await decodeGrant(Buffer.from(saved.grant, "base64"));
    const forbidden = await invoke({
      issuer: identity.parse(saved.signer),
      audience: app.service.principal,
      capability: {
        ...grant.capabilities[0]!,
        with: "urn:capvine:resource:other",
      },
      proofs: [grant],
      expiration: grant.expiration,
    }).delegate();
    await assert.rejects(
      createHttpTransport({ url: app.service.url })(
        await encodeGrant(forbidden),
      ),
      PermissionDenied,
    );
    assert.equal(fixture.counts.reads, 1);
    const port = Number(new URL(app.service.url).port);
    await app.close();
    app = await createCapvine({ ...options, port, resources, workflows });
    await app.workflows.renew(job.id);
    assert.equal((await read()).isError, undefined);
    assert.equal(fixture.counts.exchanges, 1);
    assert.equal(fixture.counts.reads, 2);
    await app.workflows.disable(approval.id);
    assert.equal((await read()).isError, true);
    await assert.rejects(app.workflows.provision(approval.id));
    await app.close();
    app = await createCapvine({ ...options, port, resources, workflows });
    assert.equal((await read()).isError, true);
    const assignment = await readFile(job.path, "utf8");
    for (const secret of fixture.secrets())
      assert.equal(assignment.includes(secret), false);
    return {
      connected: true,
      delegatedMcpRead: true,
      forbiddenReadRejected: true,
      restartAndRenewal: true,
      disabledAfterRestart: true,
    };
  } finally {
    await mcp.close();
    await app?.close();
    await fixture.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runPluginExample(), null, 2));
  console.log(
    "Local OIDC provider and custom resource fixture; no real account is connected.",
  );
}
