import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

const run = promisify(execFile);

export async function startPostgresFixture() {
  const { stdout } = await run("pg_config", ["--bindir"]);
  const bin = stdout.trim();
  const directory = await mkdtemp(join(tmpdir(), "cv-pg-"));
  const data = join(directory, "data");
  const socket = join(directory, "sock");
  await mkdir(socket);
  let started = false;
  let admin: Pool | undefined;
  const stop = async () => {
    await admin?.end();
    if (started) {
      await run(join(bin, "pg_ctl"), [
        "-D",
        data,
        "-m",
        "immediate",
        "-w",
        "stop",
      ]);
      started = false;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await run(join(bin, "initdb"), [
      "-D",
      data,
      "-U",
      "fixture_admin",
      "-A",
      "trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    await run(join(bin, "pg_ctl"), [
      "-D",
      data,
      "-l",
      join(directory, "server.log"),
      "-o",
      `-h '' -k '${socket}' -F`,
      "-w",
      "start",
    ]);
    started = true;
    admin = new Pool({
      host: socket,
      user: "fixture_admin",
      database: "postgres",
    });
    await admin.query(
      "CREATE ROLE fixture_reader LOGIN; CREATE SCHEMA capvine; CREATE TABLE capvine.database_identity (id text PRIMARY KEY); INSERT INTO capvine.database_identity VALUES ('fixture-database'); CREATE SCHEMA app; CREATE TABLE app.records (id text NOT NULL, tenant text NOT NULL, title text NOT NULL, secret text NOT NULL, PRIMARY KEY (id,tenant)); INSERT INTO app.records VALUES ('one','team-a','Allowed record','hidden-a'),('two','team-a','Other record','hidden-b'),('one','team-b','Other tenant','hidden-c'); GRANT USAGE ON SCHEMA capvine,app TO fixture_reader; GRANT SELECT ON capvine.database_identity,app.records TO fixture_reader",
    );
    return {
      admin,
      connection: {
        host: socket,
        user: "fixture_reader",
        database: "postgres",
      },
      directory,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
