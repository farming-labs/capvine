import { startPlayground } from "./server.ts";

try {
  const app = await startPlayground();
  console.log(`Delegation playground: ${app.url}`);
  console.log(
    "Simulated provider data only. Separate processes are not an OS sandbox.",
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
} catch {
  console.error(
    "Playground startup failed. Use Node.js 24+ and check that port 8788 is free.",
  );
  process.exitCode = 1;
}
