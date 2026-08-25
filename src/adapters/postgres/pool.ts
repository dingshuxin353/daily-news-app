import pg from "pg";
import type { CloudRuntimeConfig } from "../../cloud/config.js";

const { Pool } = pg;
export type PostgresPool = InstanceType<typeof Pool>;

function createPool(
  config: CloudRuntimeConfig["database"],
  options: { applicationName: string; searchPath?: "auth" },
): PostgresPool {
  const pool = new Pool({
    connectionString: config.connectionString,
    application_name: options.applicationName,
    options: options.searchPath ? `-c search_path=${options.searchPath}` : undefined,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    ssl: config.sslMode === "require" ? { rejectUnauthorized: true } : false,
  });

  pool.on("error", () => {
    console.error("PostgreSQL pool reported an unexpected idle-client error");
  });
  return pool;
}

export function createPostgresPool(config: CloudRuntimeConfig["database"]): PostgresPool {
  return createPool(config, { applicationName: "dailynews-cloud" });
}

export function createAuthPostgresPool(config: CloudRuntimeConfig["database"]): PostgresPool {
  return createPool(config, { applicationName: "dailynews-auth", searchPath: "auth" });
}

export async function verifyPostgresConnection(pool: PostgresPool): Promise<void> {
  await pool.query("SELECT 1");
}
