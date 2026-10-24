import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const gates = [
  "independentSecurityReview",
  "adopterApiReview",
  "productionHost",
  "googleLifecycle",
  "slackLifecycle",
  "publisherConfiguration",
  "releaseApproval",
] as const;

export function acceptanceTemplate(candidate: string) {
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error("Invalid candidate");
  return {
    version: 1,
    candidate,
    records: Object.fromEntries(gates.map((gate) => [gate, null])),
  };
}

export async function checkAcceptance(
  value: unknown,
  expectedCandidate: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid acceptance record");
  const document = value as Record<string, unknown>;
  if (
    Object.keys(document).sort().join() !== "candidate,records,version" ||
    document.version !== 1 ||
    document.candidate !== expectedCandidate ||
    !/^[a-f0-9]{40}$/.test(expectedCandidate)
  )
    throw new Error("Acceptance revision mismatch");
  if (
    !document.records ||
    typeof document.records !== "object" ||
    Array.isArray(document.records)
  )
    throw new Error("Invalid acceptance records");
  const records = document.records as Record<string, unknown>;
  if (Object.keys(records).sort().join() !== [...gates].sort().join())
    throw new Error("Acceptance gates must be explicit");
  const results: {
    gate: (typeof gates)[number];
    status: "missing" | "invalid" | "recorded";
  }[] = [];
  for (const gate of gates) {
    const record = records[gate];
    if (record === null) {
      results.push({ gate, status: "missing" });
      continue;
    }
    try {
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new Error();
      const row = record as Record<string, unknown>;
      if (
        Object.keys(row).sort().join() !==
          "artifact,recordedAt,recordedBy,revision,sha256,status" ||
        row.status !== "accepted" ||
        row.revision !== expectedCandidate ||
        typeof row.recordedBy !== "string" ||
        !row.recordedBy.trim() ||
        row.recordedBy.length > 256 ||
        typeof row.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(row.recordedAt)) ||
        Date.parse(row.recordedAt) > Date.now() + 60000 ||
        typeof row.artifact !== "string" ||
        !isAbsolute(row.artifact) ||
        typeof row.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.sha256)
      )
        throw new Error();
      const stat = await lstat(row.artifact);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576)
        throw new Error();
      const artifact = await readFile(row.artifact);
      if (
        !artifact.length ||
        artifact.length > 1048576 ||
        createHash("sha256").update(artifact).digest("hex") !== row.sha256
      )
        throw new Error();
      results.push({ gate, status: "recorded" });
    } catch {
      results.push({ gate, status: "invalid" });
    }
  }
  return {
    candidate: expectedCandidate,
    recordsComplete: results.every((row) => row.status === "recorded"),
    gates: results,
  };
}
