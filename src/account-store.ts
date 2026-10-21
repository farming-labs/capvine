import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateDirectory } from "./identity-file.ts";

export async function openAccountDatabase(
  directory: string,
  secret: Uint8Array,
) {
  if (secret.byteLength !== 32)
    throw new Error("A 32-byte credential key is required");
  const key = Buffer.from(secret);
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertPrivateDirectory(directory);
  const lockPath = join(directory, "accounts.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let db: DatabaseSync | undefined;
  function seal(kind: string, id: string, revision: number, value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([1, kind, id, revision])));
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }
  function unseal(
    kind: string,
    id: string,
    revision: number,
    value: Uint8Array,
  ) {
    const bytes = Buffer.from(value);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(JSON.stringify([1, kind, id, revision])));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString("utf8"),
    );
  }
  try {
    const path = join(directory, "accounts.db");
    const file = await open(
      path,
      constants.O_CREAT |
        constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid!() ||
        (info.mode & 0o077) !== 0
      )
        throw new Error("Credential database must be a private regular file");
    } finally {
      await file.close();
    }
    db = new DatabaseSync(path);
    const version = db.prepare("PRAGMA user_version").get()!.user_version;
    if (version !== 0 && version !== 1)
      throw new Error("Unsupported credential schema");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    if (
      (version === 0 && tables.length !== 0) ||
      (version === 1 &&
        (tables.length !== 1 || tables[0]!.name !== "account_records"))
    )
      throw new Error("Unrecognized credential database");
    db.exec("PRAGMA secure_delete=ON; PRAGMA synchronous=FULL;");
    if (version === 0) {
      db.exec("BEGIN IMMEDIATE");
      db.exec(
        "CREATE TABLE account_records (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=1;",
      );
      db.prepare(
        "INSERT INTO account_records VALUES ('metadata','key',0,?)",
      ).run(seal("metadata", "key", 0, { format: "capvine.accounts.v1" }));
      db.exec("COMMIT");
    }
    const check = db
      .prepare(
        "SELECT value FROM account_records WHERE kind='metadata' AND id='key'",
      )
      .get();
    if (
      !check ||
      unseal("metadata", "key", 0, check.value as Uint8Array).format !==
        "capvine.accounts.v1"
    )
      throw new Error("Credential key mismatch");
    const database = db;
    let closed = false;
    return {
      scan<T>(kind: string, after: number, limit: number) {
        return database
          .prepare(
            "SELECT rowid AS position,id,revision,value FROM account_records WHERE kind=? AND rowid>? ORDER BY rowid LIMIT ?",
          )
          .all(kind, after, limit)
          .map((row) => ({
            cursor: String(row.position),
            value: unseal(
              kind,
              String(row.id),
              Number(row.revision),
              row.value as Uint8Array,
            ) as T,
          }));
      },
      get<T>(
        kind: string,
        id: string,
      ): { revision: number; value: T } | undefined {
        const row = database
          .prepare(
            "SELECT revision,value FROM account_records WHERE kind=? AND id=?",
          )
          .get(kind, id);
        return row
          ? {
              revision: Number(row.revision),
              value: unseal(
                kind,
                id,
                Number(row.revision),
                row.value as Uint8Array,
              ) as T,
            }
          : undefined;
      },
      insert(records: { kind: string; id: string; value: unknown }[]) {
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const record of records)
            database
              .prepare("INSERT INTO account_records VALUES (?,?,0,?)")
              .run(
                record.kind,
                record.id,
                seal(record.kind, record.id, 0, record.value),
              );
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
      replace(kind: string, id: string, revision: number, value: unknown) {
        const result = database
          .prepare(
            "UPDATE account_records SET revision=?, value=? WHERE kind=? AND id=? AND revision=?",
          )
          .run(
            revision + 1,
            seal(kind, id, revision + 1, value),
            kind,
            id,
            revision,
          );
        if (result.changes !== 1) throw new Error("Connection state changed");
      },
      remove(kind: string, id: string) {
        database
          .prepare("DELETE FROM account_records WHERE kind=? AND id=?")
          .run(kind, id);
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          database.close();
        } finally {
          key.fill(0);
          await lock.close();
          await unlink(lockPath);
        }
      },
    };
  } catch {
    if (db?.isTransaction) db.exec("ROLLBACK");
    db?.close();
    key.fill(0);
    await lock.close();
    await unlink(lockPath);
    throw new Error("Credential store could not be opened");
  }
}
