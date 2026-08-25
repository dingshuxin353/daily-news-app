import pg from "pg";
import type { CloudRuntimeConfig } from "../../cloud/config.js";

const { Pool } = pg;
export type PostgresPool = InstanceType<typeof Pool>;

export function createPostgresPool(config: CloudRuntimeConfig["database"]): PostgresPool {
  const pool = new Pool({
    connectionString: config.connectionString,
    application_name: "dailynews-cloud",
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

export async function verifyPostgresConnection(pool: PostgresPool): Promise<void> {
  await pool.query("SELECT 1");
}
