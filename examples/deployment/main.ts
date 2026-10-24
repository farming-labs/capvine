import { isAbsolute } from "node:path";
import { loadWorker } from "../../src/worker.ts";
import { checkDeployment } from "./check.ts";

try {
  const [assignment, ...extra] = process.argv.slice(2);
  if (!assignment || !isAbsolute(assignment) || extra.length)
    throw new Error("Private assignment path required");
  const worker = await loadWorker(assignment);
  const checks = await checkDeployment({ worker });
  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      checks,
      limitations: [
        "Not a worker containment test",
        "No backup, monitoring, host configuration or provider-consent validation",
        "A successful permitted read does not establish harmless content",
      ],
    }),
  );
} catch {
  console.error(
    "Deployment probe did not pass. Use a valid private read-only worker assignment with an HTTPS endpoint. Verify TLS, ingress routes, limits, grant validity and resource availability. No credentials or returned content were logged.",
  );
  process.exitCode = 1;
}
