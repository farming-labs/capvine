import { dirname, resolve } from "node:path";
import { assertPrivateDirectory, readPrivateFile } from "./identity-file.ts";
import { createFilesystemAdapter } from "./filesystem.ts";
import { createPostgresAdapter, type PostgresRecord } from "./postgres.ts";
import { startResourceServer, type ResourceAdapter } from "./adapter.ts";
import type { ResourceId } from "./types.ts";

type Files = {
  type: "filesystem";
  root: string;
  connectionId: string;
  files: { id: ResourceId; path: string }[];
};
type Database = {
  type: "postgres";
  connectionId: string;
  databaseId: string;
  connectionEnv: string;
  records: PostgresRecord[];
};
export interface ServiceConfiguration {
  directory: string;
  owner: string;
  port: number;
  administrationPort: number;
  adapters: (Files | Database)[];
}

function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a configuration object");
  const result = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => ![...required, ...optional].includes(key))
  )
    throw new Error("Unknown or missing configuration field");
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new Error("Invalid configuration string");
  return value;
}
function resourceId(value: unknown): ResourceId {
  const id = text(value);
  if (!/^urn:capvine:resource:[A-Za-z0-9._:-]{1,128}$/.test(id))
    throw new Error("Invalid resource ID");
  return id as ResourceId;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid configuration list");
  return value;
}
function port(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 65535
  )
    throw new Error("Invalid port");
  return value;
}
function selector(value: unknown): { column: string; value: string } {
  const p = object(value, ["column", "value"]);
  return { column: text(p.column), value: text(p.value) };
}

export function parseConfiguration(
  value: unknown,
  baseDirectory: string,
): ServiceConfiguration {
  const input = object(
    value,
    ["directory", "owner", "adapters"],
    ["port", "administrationPort"],
  );
  const adapters = list(input.adapters).map((raw): Files | Database => {
    const common = object(
      raw,
      ["type", "connectionId"],
      ["root", "files", "databaseId", "connectionEnv", "records"],
    );
    if (common.type === "filesystem") {
      const p = object(raw, ["type", "connectionId", "root", "files"]);
      return {
        type: "filesystem",
        connectionId: text(p.connectionId),
        root: resolve(baseDirectory, text(p.root)),
        files: list(p.files).map((rawFile) => {
          const file = object(rawFile, ["id", "path"]);
          return { id: resourceId(file.id), path: text(file.path) };
        }),
      };
    }
    if (common.type === "postgres") {
      const p = object(raw, [
        "type",
        "connectionId",
        "databaseId",
        "connectionEnv",
        "records",
      ]);
      const connectionEnv = text(p.connectionEnv);
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(connectionEnv))
        throw new Error("Invalid credential environment reference");
      return {
        type: "postgres",
        connectionId: text(p.connectionId),
        databaseId: text(p.databaseId),
        connectionEnv,
        records: list(p.records).map((rawRecord) => {
          const r = object(rawRecord, [
            "id",
            "schema",
            "table",
            "key",
            "tenant",
            "columns",
          ]);
          return {
            id: resourceId(r.id),
            schema: text(r.schema),
            table: text(r.table),
            key: selector(r.key),
            tenant: selector(r.tenant),
            columns: list(r.columns).map(text),
          };
        }),
      };
    }
    throw new Error("Unsupported adapter type");
  });
  if (
    !adapters.length ||
    new Set(adapters.map((adapter) => adapter.type)).size !== adapters.length
  )
    throw new Error("Configure one adapter per type");
  const ids = adapters.flatMap((adapter) =>
    adapter.type === "filesystem"
      ? adapter.files.map((file) => file.id)
      : adapter.records.map((record) => record.id),
  );
  if (
    new Set(ids).size !== ids.length ||
    new Set(adapters.map((adapter) => adapter.connectionId)).size !==
      adapters.length
  )
    throw new Error("Duplicate configured binding");
  return {
    directory: resolve(baseDirectory, text(input.directory)),
    owner: text(input.owner),
    port: port(input.port),
    administrationPort: port(input.administrationPort),
    adapters,
  };
}

export async function loadConfiguration(
  path: string,
): Promise<ServiceConfiguration> {
  const absolute = resolve(path);
  await assertPrivateDirectory(dirname(absolute));
  return parseConfiguration(
    JSON.parse(await readPrivateFile(absolute, 65_536)),
    dirname(absolute),
  );
}

export async function startConfiguredService(
  config: ServiceConfiguration,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const settings = parseConfiguration(config, process.cwd());
  const adapters: ResourceAdapter[] = [];
  try {
    for (const adapter of settings.adapters) {
      if (adapter.type === "filesystem")
        adapters.push(
          await createFilesystemAdapter({
            root: adapter.root,
            connectionId: adapter.connectionId,
            ownerId: settings.owner,
            files: adapter.files,
          }),
        );
      else {
        const connectionString = environment[adapter.connectionEnv];
        if (
          !connectionString ||
          !/^postgres(?:ql)?:\/\//.test(connectionString)
        )
          throw new Error("Missing PostgreSQL connection credential");
        adapters.push(
          await createPostgresAdapter({
            connectionId: adapter.connectionId,
            databaseId: adapter.databaseId,
            ownerId: settings.owner,
            connection: { connectionString },
            records: adapter.records,
          }),
        );
      }
    }
    return await startResourceServer({
      directory: settings.directory,
      owner: settings.owner,
      port: settings.port,
      administrationPort: settings.administrationPort,
      adapters,
    });
  } catch (error) {
    await Promise.allSettled(adapters.map((adapter) => adapter.close()));
    throw error;
  }
}
