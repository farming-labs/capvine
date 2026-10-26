import { captureWorker, compareWorkers } from "./lifecycle.ts";

try {
  const [mode, first, second, ...extra] = process.argv.slice(2);
  if (
    !first ||
    !second ||
    extra.length ||
    (mode !== "capture" && mode !== "compare")
  )
    throw new Error("Invalid arguments");
  const checks =
    mode === "capture"
      ? await captureWorker(first, second)
      : await compareWorkers(first, second);
  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      mode,
      checks,
      limitations: [
        "Observed reads and denial only; this does not establish why access was denied or prove provider consent/reconnection",
        "Not an attestation, independent review, or host isolation check",
        "Private worker snapshots contain signing material; remove them after recording the test",
      ],
    }),
  );
} catch {
  console.error(
    "Worker lifecycle check did not pass. Check protected paths, assignment expiry, unchanged snapshots, endpoint availability and access state. No keys or resource content were logged. See docs/provider-validation.md.",
  );
  process.exitCode = 1;
}
