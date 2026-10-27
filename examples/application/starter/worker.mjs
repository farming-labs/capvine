import { loadWorker } from "@farming-labs/capvine/worker";
import { PermissionDenied } from "@farming-labs/capvine";
import { probeResource } from "./probe.mjs";

if (!process.send) throw new Error("Start this worker through the application");
const path = process.argv[2];
let worker;
try {
  worker = await loadWorker(path);
} catch {
  console.error("Worker assignment unavailable");
  process.exit(1);
}
process.send({
  ready: true,
  worker: worker.assignment.worker,
  pid: process.pid,
});
process.on("message", async ({ id, method, resource }) => {
  try {
    let value;
    if (method === "read") value = await worker.invoke();
    else if (method === "probe") value = await probeResource(path, resource);
    else throw new Error("Unknown worker operation");
    process.send?.({ id, result: { status: "allowed", value } });
  } catch (error) {
    process.send?.({
      id,
      result: {
        status: error instanceof PermissionDenied ? "denied" : "failed",
      },
    });
  }
});
process.on("disconnect", () => process.exit(0));
