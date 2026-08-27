import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import pg from "pg";
import {
  MigrationError,
  checkMigrationCompatibility,
  runMigrations,
} from "../../.cloud-dist/src/adapters/postgres/migrations.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
}
const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
if (!/(?:test|ci)/i.test(databaseName)) {
  throw new Error("PostgreSQL integration tests require a dedicated test or CI database");
}

const { Pool } = pg;
const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
const projectMigrations = path.resolve("db/migrations");

async function resetAppSchema() {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
}

async function withMigrations(files, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dailynews-migrations-"));
  try {
    for (const [filename, sql] of Object.entries(files)) {
      await writeFile(path.join(directory, filename), sql);
    }
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

before(async () => {
  const result = await pool.query("SELECT current_database() AS name, current_setting('server_version_num') AS version");
  assert.equal(result.rows[0].name, databaseName);
  assert.ok(Number(result.rows[0].version) >= 150000, "PostgreSQL 15 or newer is required");
});

after(async () => {
  await resetAppSchema();
  await pool.end();
});

test("compatibility checks do not initialize or migrate an empty database", async () => {
  await resetAppSchema();
  await assert.rejects(
    () => checkMigrationCompatibility(pool, { migrationsDirectory: projectMigrations }),
    (error) => error instanceof MigrationError && error.code === "MIGRATION_TABLE_MISSING",
  );
  const relation = await pool.query("SELECT to_regclass('app.schema_migrations')::text AS relation");
  assert.equal(relation.rows[0].relation, null);
});

test("empty database migrates fully and a repeated run has no side effects", async () => {
  await resetAppSchema();
  const first = await runMigrations(pool, { migrationsDirectory: projectMigrations });
  const second = await runMigrations(pool, { migrationsDirectory: projectMigrations });
  assert.deepEqual(first.applied, [
    "0001_initialize_app_schema.sql",
    "0002_create_tenant_foundation.sql",
    "0003_create_domain_storage.sql",
    "0100_create_email_identity.sql",
    "0101_create_agent_access.sql",
  ]);
  assert.equal(first.total, 5);
  assert.deepEqual(second.applied, []);
  const history = await pool.query(`
    SELECT filename, checksum_sha256, executed_at
    FROM app.schema_migrations
  `);
  assert.equal(history.rowCount, 5);
  assert.match(history.rows[0].checksum_sha256, /^[0-9a-f]{64}$/);
  assert.ok(history.rows[0].executed_at instanceof Date);
  await checkMigrationCompatibility(pool, { migrationsDirectory: projectMigrations });
});

test("the exact M2 migration history upgrades atomically to M3-A", async () => {
  await resetAppSchema();
  const m2Names = [
    "0001_initialize_app_schema.sql",
    "0002_create_tenant_foundation.sql",
    "0003_create_domain_storage.sql",
    "0100_create_email_identity.sql",
  ];
  const m2Files = Object.fromEntries(await Promise.all(m2Names.map(async (filename) => [
    filename,
    await readFile(path.join(projectMigrations, filename), "utf8"),
  ])));
  await withMigrations(m2Files, async (m2Directory) => {
    const m2 = await runMigrations(pool, { migrationsDirectory: m2Directory });
    assert.deepEqual(m2.applied, m2Names);
  });
  const upgraded = await runMigrations(pool, { migrationsDirectory: projectMigrations });
  assert.deepEqual(upgraded.applied, ["0101_create_agent_access.sql"]);
  assert.equal(
    (await pool.query("SELECT to_regclass('app.agent_credentials')::text AS relation")).rows[0].relation,
    "app.agent_credentials",
  );
  await checkMigrationCompatibility(pool, { migrationsDirectory: projectMigrations });
});

test("changing an applied migration fails checksum validation", async () => {
  await resetAppSchema();
  await runMigrations(pool, { migrationsDirectory: projectMigrations });
  const original = await readFile(path.join(projectMigrations, "0001_initialize_app_schema.sql"), "utf8");
  await withMigrations(
    { "0001_initialize_app_schema.sql": `${original}\nSELECT 1;\n` },
    async (directory) => {
      await assert.rejects(
        () => checkMigrationCompatibility(pool, { migrationsDirectory: directory }),
        (error) => error instanceof MigrationError && error.code === "MIGRATION_CHECKSUM_MISMATCH",
      );
      await assert.rejects(
        () => runMigrations(pool, { migrationsDirectory: directory }),
        (error) => error instanceof MigrationError && error.code === "MIGRATION_CHECKSUM_MISMATCH",
      );
    },
  );
});

test("compatibility checks fail while a local migration is pending", async () => {
  await resetAppSchema();
  await withMigrations(
    { "0001_first.sql": "CREATE TABLE app.first_probe (id integer PRIMARY KEY);" },
    async (firstDirectory) => {
      await runMigrations(pool, { migrationsDirectory: firstDirectory });
      await withMigrations(
        {
          "0001_first.sql": "CREATE TABLE app.first_probe (id integer PRIMARY KEY);",
          "0002_second.sql": "CREATE TABLE app.second_probe (id integer PRIMARY KEY);",
        },
        async (fullDirectory) => {
          await assert.rejects(
            () => checkMigrationCompatibility(pool, { migrationsDirectory: fullDirectory }),
            (error) => error instanceof MigrationError && error.code === "MIGRATION_PENDING",
          );
        },
      );
    },
  );
});

test("a failed migration rolls back its transaction and stops later files", async () => {
  await resetAppSchema();
  await withMigrations(
    {
      "0001_setup.sql": "CREATE TABLE app.rollback_probe (value integer NOT NULL);",
      "0002_fail.sql": "INSERT INTO app.rollback_probe (value) VALUES (1); SELECT missing_dailynews_function();",
      "0003_after.sql": "CREATE TABLE app.after_probe (id integer PRIMARY KEY);",
    },
    async (directory) => {
      await assert.rejects(
        () => runMigrations(pool, { migrationsDirectory: directory }),
        (error) => error instanceof MigrationError && error.code === "MIGRATION_EXECUTION_FAILED",
      );
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.rollback_probe")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT to_regclass('app.after_probe')::text AS relation")).rows[0].relation, null);
      const history = await pool.query("SELECT filename FROM app.schema_migrations ORDER BY filename");
      assert.deepEqual(history.rows.map(({ filename }) => filename), ["0001_setup.sql"]);
    },
  );
});

test("concurrent runners serialize and apply each migration once", async () => {
  await resetAppSchema();
  await withMigrations(
    {
      "0001_concurrent.sql": "SELECT pg_sleep(0.2); CREATE TABLE app.concurrent_probe (id integer PRIMARY KEY);",
    },
    async (directory) => {
      const [first, second] = await Promise.all([
        runMigrations(pool, { migrationsDirectory: directory }),
        runMigrations(pool, { migrationsDirectory: directory }),
      ]);
      assert.equal(first.applied.length + second.applied.length, 1);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.schema_migrations")).rows[0].count, 1);
      assert.equal((await pool.query("SELECT to_regclass('app.concurrent_probe')::text AS relation")).rows[0].relation, "app.concurrent_probe");
    },
  );
});
