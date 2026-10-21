import { Pool, type PoolClient, type PoolConfig } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  PermissionDenied,
  type Json,
  type Resource,
  type ResourceId,
} from "./types.ts";
import type { ResourceAdapter } from "./adapter.ts";

export interface PostgresRecord {
  id: ResourceId;
  schema: string;
  table: string;
  key: { column: string; value: string };
  tenant: { column: string; value: string };
  columns: string[];
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw new Error("Invalid PostgreSQL identifier");
  return `"${value}"`;
}

async function relation(
  client: PoolClient,
  schema: string,
  table: string,
): Promise<string> {
  const result = await client.query(
    "SELECT c.oid::text AS oid, c.relkind, c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) AS owned, pg_catalog.has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS writable FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
    [schema, table],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row.relkind !== "r" ||
    row.owned ||
    row.writable
  )
    throw new Error(
      "Expected a regular table with restricted read-only privileges",
    );
  return row.oid;
}

export async function createPostgresAdapter(options: {
  connectionId: string;
  databaseId: string;
  ownerId: string;
  connection: PoolConfig;
  records: PostgresRecord[];
  maxBytes?: number;
}): Promise<ResourceAdapter> {
  const maxBytes = options.maxBytes ?? 131_072;
  if (
    !options.connectionId ||
    !options.ownerId ||
    !/^[A-Za-z0-9-]{1,128}$/.test(options.databaseId) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 131_072 ||
    options.records.length > 256
  )
    throw new Error("Invalid PostgreSQL configuration");
  const records = structuredClone(options.records);
  const seen = new Set<string>();
  for (const record of records) {
    if (
      !record.id.startsWith("urn:capvine:resource:") ||
      seen.has(record.id) ||
      record.columns.length < 1 ||
      record.columns.length > 16 ||
      new Set(record.columns).size !== record.columns.length ||
      record.key.column === record.tenant.column ||
      [record.key.value, record.tenant.value].some(
        (value) => typeof value !== "string" || value.length > 1024,
      )
    )
      throw new Error("Invalid record binding");
    for (const name of [
      record.schema,
      record.table,
      record.key.column,
      record.tenant.column,
      ...record.columns,
    ])
      identifier(name);
    seen.add(record.id);
  }
  const databaseId = options.databaseId;
  const pool = new Pool({
    ...options.connection,
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 2000,
    query_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
  });
  let failed = false;
  let closed = false;
  pool.on("error", () => {
    failed = true;
  });
  async function transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (closed || failed)
      throw new Error("PostgreSQL connection is unavailable");
    const client = await pool.connect();
    let destroy = false;
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(
        "SET LOCAL search_path = pg_catalog; SET LOCAL statement_timeout = '2000ms'; SET LOCAL lock_timeout = '500ms'; SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
      );
      const role = (
        await client.query(
          "SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user",
        )
      ).rows[0];
      if (!role || Object.values(role).some((value) => value !== false))
        throw new Error("A restricted PostgreSQL role is required");
      await relation(client, "capvine", "database_identity");
      const identity = await client.query(
        'SELECT id FROM ONLY "capvine"."database_identity" LIMIT 2',
      );
      if (identity.rows.length !== 1 || identity.rows[0].id !== databaseId)
        throw new Error("PostgreSQL database identity mismatch");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      destroy = true;
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release(destroy);
    }
  }
  const bindings = new Map<
    string,
    { resource: Resource; record: PostgresRecord }
  >();
  const close = async () => {
    if (closed) return;
    closed = true;
    await pool.end();
  };
  try {
    await transaction(async (client) => {
      for (const record of records) {
        const oid = await relation(client, record.schema, record.table);
        const resource: Resource = {
          id: record.id,
          ownerId: options.ownerId,
          kind: "pg.record",
          target: {
            connection: options.connectionId,
            databaseId,
            relation: oid,
            schema: record.schema,
            table: record.table,
            keyColumn: record.key.column,
            keyValue: record.key.value,
            tenantColumn: record.tenant.column,
            tenantValue: record.tenant.value,
            columns: JSON.stringify(record.columns),
          },
        };
        await client.query(
          `SELECT ${record.columns.map(identifier).join(", ")} FROM ONLY ${identifier(record.schema)}.${identifier(record.table)} WHERE ${identifier(record.key.column)} = $1 AND ${identifier(record.tenant.column)} = $2 LIMIT 0`,
          [record.key.value, record.tenant.value],
        );
        bindings.set(record.id, { resource, record });
      }
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    resources: structuredClone(
      [...bindings.values()].map(({ resource }) => resource),
    ),
    operations: [
      {
        action: "pg/record.read",
        resourceKind: "pg.record",
        execute: async (resource) => {
          const binding = bindings.get(resource.id);
          if (!binding || !isDeepStrictEqual(binding.resource, resource))
            throw new PermissionDenied("Unknown PostgreSQL binding");
          return transaction(async (client) => {
            const { record } = binding;
            await client.query(
              `LOCK TABLE ONLY ${identifier(record.schema)}.${identifier(record.table)} IN ACCESS SHARE MODE`,
            );
            if (
              (await relation(client, record.schema, record.table)) !==
              resource.target.relation
            )
              throw new PermissionDenied("PostgreSQL table identity changed");
            const result = await client.query(
              `SELECT CASE WHEN pg_catalog.octet_length(payload::text) <= $3 THEN payload::text ELSE NULL END AS data FROM (SELECT pg_catalog.to_jsonb(selected) AS payload FROM (SELECT ${record.columns.map(identifier).join(", ")} FROM ONLY ${identifier(record.schema)}.${identifier(record.table)} WHERE ${identifier(record.key.column)} = $1 AND ${identifier(record.tenant.column)} = $2 LIMIT 2) selected) bounded`,
              [record.key.value, record.tenant.value, maxBytes],
            );
            if (result.rows.length > 1)
              throw new Error("Record binding is not unique");
            if (!result.rows.length) return null;
            if (typeof result.rows[0].data !== "string")
              throw new Error("PostgreSQL result exceeds read limit");
            return JSON.parse(result.rows[0].data) as Json;
          });
        },
      },
    ],
    close,
  };
}
