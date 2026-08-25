import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import type { PostgresPool } from "./pool.js";

const MIGRATION_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const ADVISORY_LOCK_NAMESPACE = 1145981271;
const ADVISORY_LOCK_KEY = 1295009857;

export type MigrationErrorCode =
  | "MIGRATION_DIRECTORY_INVALID"
  | "MIGRATION_SET_INVALID"
  | "MIGRATION_TABLE_MISSING"
  | "MIGRATION_HISTORY_UNKNOWN"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_PENDING"
  | "MIGRATION_EXECUTION_FAILED";

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export interface MigrationFile {
  filename: string;
  sequence: number;
  checksum: string;
  sql: string;
}

export interface MigrationRunResult {
  applied: string[];
  total: number;
}

interface AppliedMigration {
  filename: string;
  checksum_sha256: string;
}

function checksum(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function discoverMigrations(migrationsDirectory: string): Promise<MigrationFile[]> {
  let entries;
  try {
    entries = await readdir(migrationsDirectory, { withFileTypes: true });
  } catch (error) {
    throw new MigrationError("MIGRATION_DIRECTORY_INVALID", "migration directory is unavailable", { cause: error });
  }

  const sqlEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));
  if (sqlEntries.length === 0) {
    throw new MigrationError("MIGRATION_SET_INVALID", "migration set is empty");
  }

  const seenSequences = new Set<number>();
  const migrations: MigrationFile[] = [];
  for (const entry of sqlEntries) {
    const match = MIGRATION_NAME.exec(entry.name);
    if (!match) {
      throw new MigrationError("MIGRATION_SET_INVALID", `migration filename is invalid: ${entry.name}`);
    }
    const sequence = Number(match[1]);
    if (sequence < 1) {
      throw new MigrationError("MIGRATION_SET_INVALID", "migration sequence must start at 0001 or later");
    }
    if (seenSequences.has(sequence)) {
      throw new MigrationError("MIGRATION_SET_INVALID", `migration sequence is duplicated: ${match[1]}`);
    }
    seenSequences.add(sequence);
    const content = await readFile(path.join(migrationsDirectory, entry.name));
    if (content.toString("utf8").trim() === "") {
      throw new MigrationError("MIGRATION_SET_INVALID", `migration file is empty: ${entry.name}`);
    }
    migrations.push({
      filename: entry.name,
      sequence,
      checksum: checksum(content),
      sql: content.toString("utf8"),
    });
  }
  return migrations.sort((left, right) => left.sequence - right.sequence);
}

async function acquireMigrationLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1, $2)", [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY]);
}

async function releaseMigrationLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1, $2)", [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY]);
}

async function bootstrapMigrationTable(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS app;
      CREATE TABLE IF NOT EXISTS app.schema_migrations (
        filename text PRIMARY KEY,
        checksum_sha256 character(64) NOT NULL,
        executed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT schema_migrations_checksum_format
          CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function readAppliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(`
    SELECT filename, checksum_sha256
    FROM app.schema_migrations
    ORDER BY filename
  `);
  return result.rows;
}

function validateHistory(migrations: MigrationFile[], applied: AppliedMigration[]): Map<string, AppliedMigration> {
  const localByName = new Map(migrations.map((migration) => [migration.filename, migration]));
  const appliedByName = new Map(applied.map((migration) => [migration.filename, migration]));
  for (const record of applied) {
    const local = localByName.get(record.filename);
    if (!local) {
      throw new MigrationError("MIGRATION_HISTORY_UNKNOWN", `database contains an unknown migration: ${record.filename}`);
    }
    if (local.checksum !== record.checksum_sha256) {
      throw new MigrationError("MIGRATION_CHECKSUM_MISMATCH", `applied migration checksum changed: ${record.filename}`);
    }
  }
  let foundPending = false;
  for (const migration of migrations) {
    if (!appliedByName.has(migration.filename)) {
      foundPending = true;
    } else if (foundPending) {
      throw new MigrationError("MIGRATION_HISTORY_UNKNOWN", "database migration history is not contiguous");
    }
  }
  return appliedByName;
}

export async function runMigrations(
  pool: PostgresPool,
  options: { migrationsDirectory: string },
): Promise<MigrationRunResult> {
  const migrations = await discoverMigrations(options.migrationsDirectory);
  const client = await pool.connect();
  let locked = false;
  let destroyClient = false;
  const newlyApplied: string[] = [];
  try {
    await acquireMigrationLock(client);
    locked = true;
    await bootstrapMigrationTable(client);
    const appliedByName = validateHistory(migrations, await readAppliedMigrations(client));

    for (const migration of migrations) {
      if (appliedByName.has(migration.filename)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO app.schema_migrations (filename, checksum_sha256) VALUES ($1, $2)",
          [migration.filename, migration.checksum],
        );
        await client.query("COMMIT");
        newlyApplied.push(migration.filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new MigrationError(
          "MIGRATION_EXECUTION_FAILED",
          `migration execution failed: ${migration.filename}`,
          { cause: error },
        );
      }
    }
    return { applied: newlyApplied, total: migrations.length };
  } finally {
    if (locked) {
      try {
        await releaseMigrationLock(client);
      } catch {
        // Releasing the client also releases its session advisory lock.
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
}

export async function checkMigrationCompatibility(
  pool: PostgresPool,
  options: { migrationsDirectory: string },
): Promise<void> {
  const migrations = await discoverMigrations(options.migrationsDirectory);
  const client = await pool.connect();
  try {
    const relation = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('app.schema_migrations')::text AS relation",
    );
    if (!relation.rows[0]?.relation) {
      throw new MigrationError("MIGRATION_TABLE_MISSING", "migration metadata is not initialized");
    }
    const applied = await readAppliedMigrations(client);
    const appliedByName = validateHistory(migrations, applied);
    const pending = migrations.find((migration) => !appliedByName.has(migration.filename));
    if (pending) {
      throw new MigrationError("MIGRATION_PENDING", `database migration is pending: ${pending.filename}`);
    }
  } finally {
    client.release();
  }
}
