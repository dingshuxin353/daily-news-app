import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import { checkMigrationCompatibility } from "../adapters/postgres/migrations.js";
import {
  createAuthPostgresPool,
  createPostgresPool,
  verifyPostgresConnection,
} from "../adapters/postgres/pool.js";
import { PostgresTenancyStore } from "../adapters/postgres/tenancy.js";
import { PostgresAgentAccessRepository } from "../adapters/postgres/agent-credentials.js";
import { PostgresAgentRequestPolicy } from "../adapters/postgres/agent-rate-limit.js";
import { createIdentityService } from "../modules/identity/auth.js";
import { keyedDigest } from "../modules/identity/security.js";
import { AgentCredentialService } from "../modules/agent-access/credential-service.js";
import { AgentOperationsService } from "../modules/agent-access/operations.js";
import { PrivateReadingService } from "../modules/private-reading/service.js";
import { AgentRequestAuthenticator } from "./agent-context.js";
import { createCloudApp } from "./app.js";
import { loadCloudConfig, type CloudRuntimeConfig } from "./config.js";
import { defaultMigrationsDirectory } from "./paths.js";

export interface CloudServerRuntime {
  address: AddressInfo;
  close: () => Promise<void>;
}

function listen(server: ServerType, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("cloud server did not expose a TCP address"));
        return;
      }
      resolve(address);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: ServerType): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function startCloudServer(options: {
  config?: CloudRuntimeConfig;
  migrationsDirectory?: string;
} = {}): Promise<CloudServerRuntime> {
  const config = options.config ?? await loadCloudConfig();
  const migrationsDirectory = options.migrationsDirectory ?? defaultMigrationsDirectory;
  const pool = createPostgresPool(config.database);
  const authPool = createAuthPostgresPool(config.database);
  let app;
  try {
    const identity = createIdentityService({ config, authPool, appPool: pool });
    const tenancy = new PostgresTenancyStore(pool);
    const agentAccess = new AgentCredentialService(
      new PostgresAgentAccessRepository(pool, {
        rateLimitHours: config.product.agentAccess.rateLimitRetentionHours,
        auditDays: config.product.agentAccess.auditRetentionDays,
      }),
      {
        tokenDigestSecret: config.agentAccess.tokenDigestSecret,
        pairingCodeDigestSecret: config.agentAccess.pairingCodeDigestSecret,
        activeCredentialLimit: config.product.limits.activeTokensPerUser,
        pairingCodeTtlSeconds: config.product.agentAccess.pairingCodeTtlSeconds,
        provisioningTtlSeconds: config.product.agentAccess.provisioningTtlSeconds,
        claimIpHourlyLimit: config.product.agentAccess.claimIpHourlyLimit,
        verifyIpHourlyLimit: config.product.agentAccess.verifyIpHourlyLimit,
        apiBaseUrl: config.agentAccess.apiBaseUrl,
        mcpUrl: config.agentAccess.mcpUrl,
        pairingVerifyUrl: `${config.origin}${config.basePath}/agent-pairing/v1/verify`,
      },
    );
    const agentRequestPolicy = new PostgresAgentRequestPolicy(pool);
    const agentRequestAuthenticator = new AgentRequestAuthenticator(
      agentAccess,
      tenancy,
      agentRequestPolicy,
      {
        digestSecret: config.agentAccess.pairingCodeDigestSecret,
        rateLimitRetentionHours: config.product.agentAccess.rateLimitRetentionHours,
        readTokenHourlyLimit: config.product.agentAccess.readTokenHourlyLimit,
        writeTokenHourlyLimit: config.product.agentAccess.writeTokenHourlyLimit,
        readIpHourlyLimit: config.product.agentAccess.readIpHourlyLimit,
        writeIpHourlyLimit: config.product.agentAccess.writeIpHourlyLimit,
        credentialLastUsedTouchSeconds: config.product.agentAccess.credentialLastUsedTouchSeconds,
      },
    );
    app = createCloudApp({
      basePath: config.basePath,
      identity,
      tenancy,
      privateReading: new PrivateReadingService(pool, tenancy),
      defaults: config.product.defaults,
      agentSettings: {
        origin: config.origin,
        csrfSecret: config.identity.authSecret,
        service: agentAccess,
        digestActor: (purpose, value) => keyedDigest(
          config.agentAccess.pairingCodeDigestSecret,
          `${purpose}\0${value}`,
        ),
        apiBaseUrl: config.agentAccess.apiBaseUrl,
        mcpUrl: config.agentAccess.mcpUrl,
        activeCredentialLimit: config.product.limits.activeTokensPerUser,
        requestBodyLimitBytes: config.product.agentAccess.requestBodyLimitBytes,
      },
      agentApi: {
        authenticator: agentRequestAuthenticator,
        operations: new AgentOperationsService(pool, tenancy, agentRequestPolicy, {
          origin: config.origin,
          basePath: config.basePath,
          dailyItemLimit: config.product.agentAccess.dailyItemLimit,
          todoOperationLimit: config.product.agentAccess.todoOperationLimit,
          concurrentWriteLimitPerSpace: config.product.agentAccess.concurrentWriteLimitPerSpace,
          writeLeaseTtlSeconds: config.product.agentAccess.writeLeaseTtlSeconds,
          submissionRetentionDays: config.product.agentAccess.submissionRetentionDays,
        }),
        requestBodyLimitBytes: config.product.agentAccess.apiRequestBodyLimitBytes,
      },
      readinessCheck: async () => {
        await verifyPostgresConnection(pool);
        await checkMigrationCompatibility(pool, { migrationsDirectory });
      },
    });
  } catch (error) {
    await Promise.allSettled([pool.end(), authPool.end()]);
    throw error;
  }
  const server = createAdaptorServer({
    fetch: app.fetch,
    hostname: config.host,
  });
  let address: AddressInfo;
  try {
    address = await listen(server, config.host, config.port);
  } catch (error) {
    await closeServer(server).catch(() => {});
    await Promise.allSettled([pool.end(), authPool.end()]);
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      await closeServer(server);
      await Promise.all([pool.end(), authPool.end()]);
    })();
    return closing;
  };
  console.log(`DailyNews cloud runtime listening on ${address.address}:${address.port}`);
  return { address, close };
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
