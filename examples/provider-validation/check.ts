import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { invoke } from "@ucanto/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AccountManager } from "../../src/accounts.ts";
import {
  startResourceServer,
  type ResourceAdapter,
} from "../../src/adapter.ts";
import { createAdministrationClient } from "../../src/administration.ts";
import { createHttpTransport } from "../../src/http.ts";
import { initializeService } from "../../src/service.ts";
import { readPrivateFile } from "../../src/identity-file.ts";
import { provisionWorker } from "../../src/worker.ts";
import { encodeGrant, identity, PermissionDenied } from "../../src/index.ts";

export async function checkProviderRead(options: {
  ownerId: string;
  openAccounts: () => Promise<AccountManager>;
  adapter: (accounts: AccountManager) => ResourceAdapter;
}) {
  const temporary = await mkdtemp(join(tmpdir(), "capvine-provider-check-"));
  const directory = join(temporary, "authority");
  let accounts: AccountManager | undefined;
  let server: Awaited<ReturnType<typeof startResourceServer>> | undefined;
  const mcp = new Client({ name: "provider-validation", version: "0.0.0" });
  try {
    accounts = await options.openAccounts();
    const adapter = options.adapter(accounts);
    assert.equal(adapter.resources.length, 1);
    assert.equal(adapter.operations.length, 1);
    const resource = adapter.resources[0]!;
    const action = adapter.operations[0]!.action;
    await initializeService(directory, options.ownerId);
    server = await startResourceServer({
      directory,
      owner: options.ownerId,
      adapters: [adapter],
    });
    const token = await readPrivateFile(join(directory, "admin.token"));
    const admin = () =>
      createAdministrationClient({ url: server!.administrationUrl, token });
    const coordinator = await identity.generate();
    await admin().approveWorkflow({
      id: "provider-read",
      audience: coordinator,
      resource: resource.id,
      action,
      expiresAt: new Date(Date.now() + 3600_000),
      maxGrantSeconds: 600,
    });
    const parent = await admin().issueApproved("provider-read");
    const workers = join(temporary, "workers");
    await mkdir(workers, { mode: 0o700 });
    const path = join(workers, "reader.json");
    await provisionWorker({
      path,
      coordinator,
      grant: parent,
      url: server.url,
      toolName: "read_selected_message",
      expiresAt: new Date(Date.now() + 300_000),
    });
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
          "worker",
          path,
        ],
        env: {},
        stderr: "pipe",
      }),
    );
    const read = () => mcp.callTool({ name: "read_selected_message" });
    const first = await read();
    assert.equal(
      first.isError,
      undefined,
      "The selected provider message could not be read",
    );
    assert.ok(Array.isArray(first.content) && first.content.length > 0);
    const forged = await invoke({
      issuer: coordinator,
      audience: server.principal,
      capability: {
        ...parent.capabilities[0]!,
        with: "urn:capvine:resource:unassigned",
      },
      proofs: [parent],
      expiration: parent.expiration,
    }).delegate();
    await assert.rejects(
      createHttpTransport({ url: server.url })(await encodeGrant(forged)),
      PermissionDenied,
    );
    const port = Number(new URL(server.url).port);
    await server.close();
    await accounts.close();
    accounts = await options.openAccounts();
    server = await startResourceServer({
      directory,
      owner: options.ownerId,
      port,
      adapters: [options.adapter(accounts)],
    });
    assert.equal(
      (await read()).isError,
      undefined,
      "Read after restart failed",
    );
    await admin().revoke(parent.cid.toString());
    assert.equal(
      (await read()).isError,
      true,
      "Revoked parent remained usable",
    );
    await admin().disableApproval("provider-read");
    await assert.rejects(admin().issueApproved("provider-read"), /403/);
    return {
      delegatedMcpRead: true,
      rawRetargetingRejected: true,
      readAfterRestart: true,
      parentRevocation: true,
      workflowDisable: true,
    };
  } finally {
    await mcp.close();
    await server?.close();
    await accounts?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function checkProviderRejection(options: {
  ownerId: string;
  connectionId: string;
  provider: string;
  subject: string;
  openAccounts: () => Promise<AccountManager>;
}) {
  let accounts = await options.openAccounts();
  let credentialReachedHandler = false;
  const probe = () =>
    accounts.withAccessToken(options, async () => {
      credentialReachedHandler = true;
    });
  try {
    const initial = accounts.inspect(options.ownerId, options.connectionId);
    assert.equal(initial.provider, options.provider);
    assert.equal(initial.subject, options.subject);
    await assert.rejects(
      probe,
      "The provider still accepts this connection; revocation has not been established",
    );
    assert.equal(credentialReachedHandler, false);
    assert.equal(
      accounts.inspect(options.ownerId, options.connectionId).status,
      "reconnect_required",
      "A transient error or local disconnect is not evidence of provider rejection",
    );
    await accounts.close();
    accounts = await options.openAccounts();
    assert.equal(
      accounts.inspect(options.ownerId, options.connectionId).status,
      "reconnect_required",
    );
    await assert.rejects(probe);
    assert.equal(credentialReachedHandler, false);
    return {
      credentialUseBlocked: true,
      reconnectRequiredAfterRestart: true,
      newlyObservedRejection: initial.status === "connected",
    };
  } finally {
    await accounts.close();
  }
}
