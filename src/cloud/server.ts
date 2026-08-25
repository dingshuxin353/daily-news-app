import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { checkMigrationCompatibility } from "../adapters/postgres/migrations.js";
import { createPostgresPool, verifyPostgresConnection } from "../adapters/postgres/pool.js";
import { createCloudApp } from "./app.js";
import { loadCloudConfig } from "./config.js";
import { defaultMigrationsDirectory } from "./paths.js";

export async function startCloudServer(): Promise<{
  close: () => Promise<void>;
}> {
  const config = await loadCloudConfig();
  const pool = createPostgresPool(config.database);
  const app = createCloudApp({
    basePath: config.basePath,
    readinessCheck: async () => {
      await verifyPostgresConnection(pool);
      await checkMigrationCompatibility(pool, { migrationsDirectory: defaultMigrationsDirectory });
    },
  });
  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
      await pool.end();
    })();
    return closing;
  };
  console.log(`DailyNews cloud runtime listening on ${config.host}:${config.port}`);
  return { close };
}

async function main(): Promise<void> {
  const runtime = await startCloudServer();
  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    try {
      await runtime.close();
      clearTimeout(deadline);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  main().catch(() => {
    console.error("DailyNews cloud runtime failed to start");
    process.exitCode = 1;
  });
}
