#!/usr/bin/env node
import { initializeService } from "./service.ts";
import { loadConfiguration, startConfiguredService } from "./configuration.ts";

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
  } else {
    console.error(
      "Usage: capvine init <new-state-directory> <owner> | capvine serve <private-config.json>",
    );
    process.exitCode = 1;
  }
} catch {
  console.error(
    "Capvine startup failed. Check protected configuration, credentials, resource permissions, and state.",
  );
  process.exitCode = 1;
}
