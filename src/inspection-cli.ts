import { isAbsolute } from "node:path";
import { createAdministrationClient } from "./administration.ts";
import { readPrivateFile } from "./identity-file.ts";

export async function inspectService(path: string, kind: "grants" | "audit") {
  const input: unknown = JSON.parse(await readPrivateFile(path));
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid inspection configuration");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["url", "tokenFile", "after", "limit"].includes(key),
    ) ||
    typeof value.url !== "string" ||
    typeof value.tokenFile !== "string" ||
    !isAbsolute(value.tokenFile) ||
    (value.after !== undefined &&
      (typeof value.after !== "string" || value.after.length > 1024)) ||
    (value.limit !== undefined &&
      (typeof value.limit !== "number" ||
        !Number.isSafeInteger(value.limit) ||
        value.limit < 1 ||
        value.limit > 100))
  )
    throw new Error("Invalid inspection configuration");
  const client = createAdministrationClient({
    url: value.url,
    token: await readPrivateFile(value.tokenFile),
  });
  const query = {
    ...(value.after === undefined ? {} : { after: value.after as string }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
  };
  return kind === "grants" ? client.listGrants(query) : client.listAudit(query);
}
