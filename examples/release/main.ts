import { execFileSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { writePrivateFile } from "../../src/identity-file.ts";
import { acceptanceTemplate, checkAcceptance } from "./acceptance.ts";

try {
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const [first, second, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error();
  if (first === "--template") {
    if (!second || !isAbsolute(second)) throw new Error();
    await writePrivateFile(
      second,
      JSON.stringify(acceptanceTemplate(candidate), null, 2),
    );
    console.log(
      "Created a private acceptance template for the current revision. Every gate is still missing.",
    );
  } else {
    if (second || (first && !isAbsolute(first))) throw new Error();
    let value: unknown = acceptanceTemplate(candidate);
    if (first) {
      const stat = await lstat(first);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        throw new Error();
      value = JSON.parse(await readFile(first, "utf8"));
    }
    const report = await checkAcceptance(value, candidate);
    console.log(
      JSON.stringify(
        {
          ...report,
          limitation:
            "This checks revision, record completeness and artifact hashes. It does not verify reviewer independence, attest to findings or authorize publication.",
        },
        null,
        2,
      ),
    );
    if (!report.recordsComplete) process.exitCode = 1;
  }
} catch {
  console.error(
    "Acceptance check failed. Use a bounded private JSON record for the current full Git revision and readable evidence files. No evidence contents were logged.",
  );
  process.exitCode = 1;
}
