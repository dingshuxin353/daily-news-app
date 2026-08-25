import { pathToFileURL } from "node:url";
import { MigrationError, runMigrations } from "../adapters/postgres/migrations.js";
import { createPostgresPool } from "../adapters/postgres/pool.js";
import { loadCloudConfig } from "./config.js";
import { defaultMigrationsDirectory } from "./paths.js";

export async function migrateDatabase(): Promise<void> {
  const config = await loadCloudConfig();
  const pool = createPostgresPool(config.database);
  try {
    const result = await runMigrations(pool, { migrationsDirectory: defaultMigrationsDirectory });
    console.log(`Database migrations complete: ${result.applied.length} applied, ${result.total} total`);
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  migrateDatabase().catch((error: unknown) => {
    const code = error instanceof MigrationError ? error.code : "DATABASE_MIGRATION_FAILED";
    console.error(`Database migration failed: ${code}`);
    process.exitCode = 1;
  });
}
