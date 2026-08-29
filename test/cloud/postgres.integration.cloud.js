import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
    "0102_create_agent_request_layer.sql",
    "0103_create_m4_domain_contract.sql",
  ]);
  assert.equal(first.total, 7);
  assert.deepEqual(second.applied, []);
  const history = await pool.query(`
    SELECT filename, checksum_sha256, executed_at
    FROM app.schema_migrations
  `);
  assert.equal(history.rowCount, 7);
  assert.match(history.rows[0].checksum_sha256, /^[0-9a-f]{64}$/);
  assert.ok(history.rows[0].executed_at instanceof Date);
  await checkMigrationCompatibility(pool, { migrationsDirectory: projectMigrations });
});

test("the exact M2 migration history upgrades atomically through M3-B", async () => {
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
  assert.deepEqual(upgraded.applied, [
    "0101_create_agent_access.sql",
    "0102_create_agent_request_layer.sql",
    "0103_create_m4_domain_contract.sql",
  ]);
  assert.equal(
    (await pool.query("SELECT to_regclass('app.agent_credentials')::text AS relation")).rows[0].relation,
    "app.agent_credentials",
  );
  await checkMigrationCompatibility(pool, { migrationsDirectory: projectMigrations });
});

test("the exact M3 schema and retained facts upgrade to the M4 domain contract", async () => {
  await resetAppSchema();
  const m3Names = [
    "0001_initialize_app_schema.sql",
    "0002_create_tenant_foundation.sql",
    "0003_create_domain_storage.sql",
    "0100_create_email_identity.sql",
    "0101_create_agent_access.sql",
    "0102_create_agent_request_layer.sql",
  ];
  const m3Files = Object.fromEntries(await Promise.all(m3Names.map(async (filename) => [
    filename,
    await readFile(path.join(projectMigrations, filename), "utf8"),
  ])));
  await withMigrations(m3Files, async (m3Directory) => {
    assert.deepEqual((await runMigrations(pool, { migrationsDirectory: m3Directory })).applied, m3Names);
  });

  const spaceId = randomUUID();
  const homeSelectionId = randomUUID();
  const dailySelectionId = randomUUID();
  const archiveSelectionId = randomUUID();
  const otherSelectionId = randomUUID();
  await pool.query(
    `INSERT INTO auth."user" ("id", "name", "email", "emailVerified")
     VALUES ('m3-user', 'm3-user@example.test', 'm3-user@example.test', true)`,
  );
  await pool.query("INSERT INTO app.spaces (id, user_id, status) VALUES ($1, 'm3-user', 'ready')", [spaceId]);
  await pool.query(
    "INSERT INTO app.home_profiles (space_id, display_name, time_zone) VALUES ($1, '  Retained Home  ', 'Asia/Shanghai')",
    [spaceId],
  );
  await pool.query(
    `INSERT INTO app.publications
       (space_id, publication_id, display_name, status, is_default, sort_order)
     VALUES ($1, 'daily-news', '  DailyNews  ', 'active', true, 0),
            ($1, 'archive-news', 'Archive News', 'inactive', false, 1),
            ($1, 'other-news', 'dailynews', 'active', false, 2)`,
    [spaceId],
  );
  await pool.query(
    `INSERT INTO app.publication_configs
       (space_id, publication_id, time_zone, priority_limits)
     VALUES ($1, 'daily-news', 'Asia/Shanghai', '{"lead":1,"important":2,"normal":null}'::jsonb),
            ($1, 'archive-news', 'Asia/Shanghai', '{"lead":1,"important":2,"normal":null}'::jsonb),
            ($1, 'other-news', 'Asia/Shanghai', '{"lead":1,"important":2,"normal":null}'::jsonb)`,
    [spaceId],
  );
  await pool.query(
    `INSERT INTO app.theme_selections
       (id, space_id, target_type, publication_id, selection_mode, theme_id, theme_revision, active_payload)
     VALUES ($2, $1, 'home', NULL, 'override', 'retained-theme', 2, '{}'::jsonb),
            ($3, $1, 'publication', 'daily-news', 'inherit', NULL, NULL, NULL),
            ($4, $1, 'publication', 'archive-news', 'override', 'retained-theme', 1, '{}'::jsonb),
            ($5, $1, 'publication', 'other-news', 'inherit', NULL, NULL, NULL)`,
    [spaceId, homeSelectionId, dailySelectionId, archiveSelectionId, otherSelectionId],
  );
  await pool.query("INSERT INTO app.todo_profiles (space_id, enabled) VALUES ($1, false)", [spaceId]);
  await pool.query(
    `INSERT INTO app.theme_definitions
       (space_id, theme_id, revision, definition_payload, compiled_css)
     VALUES ($1, 'retained-theme', 1, $2::jsonb, ':root { --revision: 1; }'),
            ($1, 'retained-theme', 2, $3::jsonb, ':root { --revision: 2; }')`,
    [
      spaceId,
      JSON.stringify({ id: "retained-theme", revision: 1, name: "Retained Theme" }),
      JSON.stringify({ id: "retained-theme", revision: 2, name: "x".repeat(80) }),
    ],
  );
  await pool.query(
    `INSERT INTO app.theme_candidates
       (space_id, theme_id, candidate_hash, input_hash, manifest_payload, compiled_css)
     VALUES ($1, 'discarded-preview', $2, $3, '{"themeId":"discarded-preview"}'::jsonb, ':root {}')`,
    [spaceId, "a".repeat(64), "b".repeat(64)],
  );

  assert.deepEqual((await runMigrations(pool, { migrationsDirectory: projectMigrations })).applied, [
    "0103_create_m4_domain_contract.sql",
  ]);
  const publications = await pool.query(
    `SELECT publication_id, display_name, status, sort_order
     FROM app.publications WHERE space_id = $1 ORDER BY publication_id`,
    [spaceId],
  );
  assert.deepEqual(publications.rows, [
    { publication_id: "archive-news", display_name: "Archive News", status: "inactive", sort_order: null },
    { publication_id: "daily-news", display_name: "DailyNews", status: "active", sort_order: 0 },
    { publication_id: "other-news", display_name: "dailynews (2)", status: "active", sort_order: 1 },
  ]);
  assert.equal((await pool.query("SELECT display_name FROM app.home_profiles WHERE space_id = $1", [spaceId])).rows[0].display_name, "Retained Home");
  assert.deepEqual((await pool.query(
    "SELECT theme_id, current_revision, display_name, status FROM app.custom_themes WHERE space_id = $1",
    [spaceId],
  )).rows[0], {
    theme_id: "retained-theme",
    current_revision: 2,
    display_name: "retained-theme",
    status: "active",
  });
  const removedColumns = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'app'
       AND ((table_name = 'publications' AND column_name = 'is_default')
         OR (table_name = 'theme_selections' AND column_name IN ('theme_revision', 'active_payload')))`,
  );
  assert.equal(removedColumns.rowCount, 0);
  assert.equal((await pool.query("SELECT to_regclass('app.theme_candidates')::text AS relation")).rows[0].relation, null);
  assert.equal((await pool.query("SELECT to_regclass('app.user_profiles')::text AS relation")).rows[0].relation, "app.user_profiles");
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
