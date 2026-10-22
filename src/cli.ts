#!/usr/bin/env node
import { initializeService } from "./service.ts";
import { loadConfiguration, startConfiguredService } from "./configuration.ts";
import { loadWorker } from "./worker.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

try {
  const [command, path, owner, ...extra] = process.argv.slice(2);
  if (command === "init" && path && owner && !extra.length) {
    console.log(
      JSON.stringify({ service: await initializeService(path, owner) }),
    );
  } else if (command === "serve" && path && owner === undefined) {
    const service = await startConfiguredService(await loadConfiguration(path));
    console.log(
      JSON.stringify({
        service: service.principal.did(),
        url: service.url,
        administrationUrl: service.administrationUrl,
      }),
    );
    const close = () => {
      void service.close().catch(() => {
        console.error("Capvine shutdown failed");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } else if (command === "worker" && path && owner === undefined) {
    const worker = await loadWorker(path);
    const server = worker.createMcpServer();
    await server.connect(new StdioServerTransport());
    const close = () => {
      void server.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } else {
    console.error(
      "Usage: capvine init <new-state-directory> <owner> | capvine serve <private-config.json> | capvine worker <private-assignment.json>",
    );
    process.exitCode = 1;
  }
} catch {
  console.error(
    "Capvine startup failed. Check protected configuration, credentials, resource permissions, and state.",
  );
  process.exitCode = 1;
}
