import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class CloudConfigError extends Error {
  readonly code = "CLOUD_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CloudConfigError";
  }
}

export interface CloudFileConfig {
  schemaVersion: 1;
  defaults: {
    spaceName: string;
    timeZone: string;
    publicationId: string;
    publicationName: string;
    theme: { id: string; revision: number };
    todoEnabled: boolean;
    priorityLimits: { lead: number; important: number; normal: number | null };
  };
  limits: {
    publicationsPerSpace: number;
    activeTokensPerUser: number;
    testDailyEmailHardLimit: number;
    emailCooldownSeconds: number;
    emailHourlyLimit: number;
    ipHourlyLimit: number;
  };
  identity: {
    otpLength: number;
    otpExpiresInSeconds: number;
    otpAllowedAttempts: number;
    sessionExpiresInDays: number;
  };
  agentAccess: {
    pairingCodeTtlSeconds: number;
    provisioningTtlSeconds: number;
    claimIpHourlyLimit: number;
    verifyIpHourlyLimit: number;
    requestBodyLimitBytes: number;
    rateLimitRetentionHours: number;
    auditRetentionDays: number;
    apiRequestBodyLimitBytes: number;
    mcpRequestBodyLimitBytes: number;
    readTokenHourlyLimit: number;
    writeTokenHourlyLimit: number;
    readIpHourlyLimit: number;
    writeIpHourlyLimit: number;
    dailyItemLimit: number;
    todoOperationLimit: number;
    concurrentWriteLimitPerSpace: number;
    writeLeaseTtlSeconds: number;
    credentialLastUsedTouchSeconds: number;
    submissionRetentionDays: number;
  };
}

export interface TencentSesRuntimeConfig {
  secretId: string;
  secretKey: string;
  region: string;
  fromEmailAddress: string;
  templateId: number;
  subject: string;
}

export interface CloudRuntimeConfig {
  origin: string;
  basePath: string;
  host: string;
  port: number;
  database: {
    connectionString: string;
    sslMode: "disable" | "require";
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
  };
  identity: {
    authSecret: string;
    digestSecret: string;
    mailMode: "fake" | "ses";
    ses?: TencentSesRuntimeConfig;
  };
  agentAccess: {
    tokenDigestSecret: string;
    pairingCodeDigestSecret: string;
    apiBaseUrl: string;
    mcpUrl: string;
  };
  product: CloudFileConfig;
}

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const defaultCloudConfigPath = path.join(projectRoot, "config", "cloud.json");

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CloudConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new CloudConfigError(`${label} must be a boolean`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CloudConfigError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function validateCloudFileConfig(value: unknown): CloudFileConfig {
  const root = requireRecord(value, "cloud config");
  if (root.schemaVersion !== 1) {
    throw new CloudConfigError("cloud config schemaVersion is unsupported");
  }
  const defaults = requireRecord(root.defaults, "defaults");
  const theme = requireRecord(defaults.theme, "defaults.theme");
  const priorityLimits = requireRecord(defaults.priorityLimits, "defaults.priorityLimits");
  const limits = requireRecord(root.limits, "limits");
  const identity = requireRecord(root.identity, "identity");
  const agentAccess = requireRecord(root.agentAccess, "agentAccess");
  const normal = priorityLimits.normal;
  if (normal !== null && (!Number.isInteger(normal) || (normal as number) < 0)) {
    throw new CloudConfigError("defaults.priorityLimits.normal must be null or a non-negative integer");
  }

  return {
    schemaVersion: 1,
    defaults: {
      spaceName: requireString(defaults.spaceName, "defaults.spaceName"),
      timeZone: requireString(defaults.timeZone, "defaults.timeZone"),
      publicationId: requireString(defaults.publicationId, "defaults.publicationId"),
      publicationName: requireString(defaults.publicationName, "defaults.publicationName"),
      theme: {
        id: requireString(theme.id, "defaults.theme.id"),
        revision: requireInteger(theme.revision, "defaults.theme.revision", 1, Number.MAX_SAFE_INTEGER),
      },
      todoEnabled: requireBoolean(defaults.todoEnabled, "defaults.todoEnabled"),
      priorityLimits: {
        lead: requireInteger(priorityLimits.lead, "defaults.priorityLimits.lead", 0, 100),
        important: requireInteger(priorityLimits.important, "defaults.priorityLimits.important", 0, 100),
        normal: normal as number | null,
      },
    },
    limits: {
      publicationsPerSpace: requireInteger(limits.publicationsPerSpace, "limits.publicationsPerSpace", 1, 100),
      activeTokensPerUser: requireInteger(limits.activeTokensPerUser, "limits.activeTokensPerUser", 1, 100),
      testDailyEmailHardLimit: requireInteger(limits.testDailyEmailHardLimit, "limits.testDailyEmailHardLimit", 1, 10000),
      emailCooldownSeconds: requireInteger(limits.emailCooldownSeconds, "limits.emailCooldownSeconds", 1, 3600),
      emailHourlyLimit: requireInteger(limits.emailHourlyLimit, "limits.emailHourlyLimit", 1, 1000),
      ipHourlyLimit: requireInteger(limits.ipHourlyLimit, "limits.ipHourlyLimit", 1, 10000),
    },
    identity: {
      otpLength: requireInteger(identity.otpLength, "identity.otpLength", 6, 6),
      otpExpiresInSeconds: requireInteger(identity.otpExpiresInSeconds, "identity.otpExpiresInSeconds", 60, 1800),
      otpAllowedAttempts: requireInteger(identity.otpAllowedAttempts, "identity.otpAllowedAttempts", 1, 10),
      sessionExpiresInDays: requireInteger(identity.sessionExpiresInDays, "identity.sessionExpiresInDays", 1, 90),
    },
    agentAccess: {
      pairingCodeTtlSeconds: requireInteger(
        agentAccess.pairingCodeTtlSeconds,
        "agentAccess.pairingCodeTtlSeconds",
        60,
        3600,
      ),
      provisioningTtlSeconds: requireInteger(
        agentAccess.provisioningTtlSeconds,
        "agentAccess.provisioningTtlSeconds",
        60,
        3600,
      ),
      claimIpHourlyLimit: requireInteger(agentAccess.claimIpHourlyLimit, "agentAccess.claimIpHourlyLimit", 1, 1000),
      verifyIpHourlyLimit: requireInteger(agentAccess.verifyIpHourlyLimit, "agentAccess.verifyIpHourlyLimit", 1, 1000),
      requestBodyLimitBytes: requireInteger(
        agentAccess.requestBodyLimitBytes,
        "agentAccess.requestBodyLimitBytes",
        1024,
        1024 * 1024,
      ),
      rateLimitRetentionHours: requireInteger(
        agentAccess.rateLimitRetentionHours,
        "agentAccess.rateLimitRetentionHours",
        1,
        24 * 30,
      ),
      auditRetentionDays: requireInteger(agentAccess.auditRetentionDays, "agentAccess.auditRetentionDays", 1, 3650),
      apiRequestBodyLimitBytes: requireInteger(
        agentAccess.apiRequestBodyLimitBytes,
        "agentAccess.apiRequestBodyLimitBytes",
        1024,
        4 * 1024 * 1024,
      ),
      mcpRequestBodyLimitBytes: requireInteger(
        agentAccess.mcpRequestBodyLimitBytes,
        "agentAccess.mcpRequestBodyLimitBytes",
        1024,
        4 * 1024 * 1024,
      ),
      readTokenHourlyLimit: requireInteger(
        agentAccess.readTokenHourlyLimit,
        "agentAccess.readTokenHourlyLimit",
        1,
        100000,
      ),
      writeTokenHourlyLimit: requireInteger(
        agentAccess.writeTokenHourlyLimit,
        "agentAccess.writeTokenHourlyLimit",
        1,
        100000,
      ),
      readIpHourlyLimit: requireInteger(
        agentAccess.readIpHourlyLimit,
        "agentAccess.readIpHourlyLimit",
        1,
        100000,
      ),
      writeIpHourlyLimit: requireInteger(
        agentAccess.writeIpHourlyLimit,
        "agentAccess.writeIpHourlyLimit",
        1,
        100000,
      ),
      dailyItemLimit: requireInteger(agentAccess.dailyItemLimit, "agentAccess.dailyItemLimit", 1, 1000),
      todoOperationLimit: requireInteger(
        agentAccess.todoOperationLimit,
        "agentAccess.todoOperationLimit",
        1,
        1000,
      ),
      concurrentWriteLimitPerSpace: requireInteger(
        agentAccess.concurrentWriteLimitPerSpace,
        "agentAccess.concurrentWriteLimitPerSpace",
        1,
        100,
      ),
      writeLeaseTtlSeconds: requireInteger(
        agentAccess.writeLeaseTtlSeconds,
        "agentAccess.writeLeaseTtlSeconds",
        30,
        3600,
      ),
      credentialLastUsedTouchSeconds: requireInteger(
        agentAccess.credentialLastUsedTouchSeconds,
        "agentAccess.credentialLastUsedTouchSeconds",
        1,
        86400,
      ),
      submissionRetentionDays: requireInteger(
        agentAccess.submissionRetentionDays,
        "agentAccess.submissionRetentionDays",
        1,
        3650,
      ),
    },
  };
}

function requireSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireString(env[name], name);
  if (value.length < 32) {
    throw new CloudConfigError(`${name} must contain at least 32 characters`);
  }
  return value;
}

function parseMailConfiguration(env: NodeJS.ProcessEnv): CloudRuntimeConfig["identity"] {
  const mailMode = requireString(env.MAIL_MODE, "MAIL_MODE");
  if (mailMode !== "fake" && mailMode !== "ses") {
    throw new CloudConfigError("MAIL_MODE must be fake or ses");
  }
  const identity: CloudRuntimeConfig["identity"] = {
    authSecret: requireSecret(env, "BETTER_AUTH_SECRET"),
    digestSecret: requireSecret(env, "IDENTITY_DIGEST_SECRET"),
    mailMode,
  };
  if (mailMode === "ses") {
    identity.ses = {
      secretId: requireString(env.TENCENTCLOUD_SECRET_ID, "TENCENTCLOUD_SECRET_ID"),
      secretKey: requireString(env.TENCENTCLOUD_SECRET_KEY, "TENCENTCLOUD_SECRET_KEY"),
      region: requireString(env.TENCENT_SES_REGION, "TENCENT_SES_REGION"),
      fromEmailAddress: requireString(env.TENCENT_SES_FROM_EMAIL, "TENCENT_SES_FROM_EMAIL"),
      templateId: parseIntegerEnvironment(env, "TENCENT_SES_TEMPLATE_ID", 0, 1, Number.MAX_SAFE_INTEGER),
      subject: requireString(env.TENCENT_SES_SUBJECT, "TENCENT_SES_SUBJECT"),
    };
  }
  return identity;
}

function parseIntegerEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new CloudConfigError(`${name} must be an integer`);
  }
  return requireInteger(Number(raw), name, minimum, maximum);
}

function parseOrigin(raw: string | undefined): string {
  if (!raw) throw new CloudConfigError("CLOUD_ORIGIN is required");
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new CloudConfigError("CLOUD_ORIGIN must be an absolute URL");
  }
  const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "localhost" || origin.hostname === "[::1]";
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) {
    throw new CloudConfigError("CLOUD_ORIGIN must use HTTPS except on loopback hosts");
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new CloudConfigError("CLOUD_ORIGIN must contain only scheme, host, and optional port");
  }
  return origin.origin;
}

function parseBasePath(raw: string | undefined): string {
  const value = raw ?? "";
  if (value === "") return value;
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(value)) {
    throw new CloudConfigError("CLOUD_BASE_PATH must be empty or an absolute path without a trailing slash");
  }
  return value;
}

function parseAgentEndpoint(raw: string | undefined, name: string, origin: string, expectedPath: string): string {
  const value = requireString(raw, name);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new CloudConfigError(`${name} must be an absolute URL`);
  }
  if (endpoint.origin !== origin || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new CloudConfigError(`${name} must use CLOUD_ORIGIN without credentials, query, or fragment`);
  }
  if (endpoint.pathname !== expectedPath) {
    throw new CloudConfigError(`${name} must use the configured cloud base path`);
  }
  return endpoint.href.replace(/\/$/, "");
}

function parseDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new CloudConfigError("DATABASE_URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudConfigError("DATABASE_URL must be a PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new CloudConfigError("DATABASE_URL must be a PostgreSQL URL");
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new CloudConfigError("DATABASE_URL must name a host and database");
  }
  const sslParameter = [...url.searchParams.keys()].find((name) => name.toLowerCase().startsWith("ssl"));
  if (sslParameter) {
    throw new CloudConfigError("DATABASE_URL must not contain SSL parameters; use PG_SSL_MODE");
  }
  return raw;
}

function parseHost(raw: string | undefined): string {
  const value = raw || "127.0.0.1";
  if (isIP(value) || value === "localhost" || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) {
    return value;
  }
  throw new CloudConfigError("CLOUD_HOST must be a valid IP address or hostname");
}

export async function loadCloudConfig(options: {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
} = {}): Promise<CloudRuntimeConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultCloudConfigPath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new CloudConfigError("cloud config file could not be loaded");
  }

  const sslMode = env.PG_SSL_MODE ?? "disable";
  if (sslMode !== "disable" && sslMode !== "require") {
    throw new CloudConfigError("PG_SSL_MODE must be disable or require");
  }

  const origin = parseOrigin(env.CLOUD_ORIGIN);
  const basePath = parseBasePath(env.CLOUD_BASE_PATH);
  const identity = parseMailConfiguration(env);
  const tokenDigestSecret = requireSecret(env, "AGENT_TOKEN_DIGEST_SECRET");
  const pairingCodeDigestSecret = requireSecret(env, "PAIRING_CODE_DIGEST_SECRET");
  if (new Set([
    identity.authSecret,
    identity.digestSecret,
    tokenDigestSecret,
    pairingCodeDigestSecret,
  ]).size !== 4) {
    throw new CloudConfigError("identity and Agent secrets must be independent");
  }
  return {
    origin,
    basePath,
    host: parseHost(env.CLOUD_HOST),
    port: parseIntegerEnvironment(env, "CLOUD_PORT", 3000, 1, 65535),
    database: {
      connectionString: parseDatabaseUrl(env.DATABASE_URL),
      sslMode,
      max: parseIntegerEnvironment(env, "PG_POOL_MAX", 10, 1, 100),
      idleTimeoutMillis: parseIntegerEnvironment(env, "PG_IDLE_TIMEOUT_MS", 30000, 1000, 600000),
      connectionTimeoutMillis: parseIntegerEnvironment(env, "PG_CONNECTION_TIMEOUT_MS", 5000, 100, 60000),
    },
    identity,
    agentAccess: {
      tokenDigestSecret,
      pairingCodeDigestSecret,
      apiBaseUrl: parseAgentEndpoint(env.AGENT_API_BASE_URL, "AGENT_API_BASE_URL", origin, `${basePath}/api/v1`),
      mcpUrl: parseAgentEndpoint(env.AGENT_MCP_URL, "AGENT_MCP_URL", origin, `${basePath}/mcp`),
    },
    product: validateCloudFileConfig(parsed),
  };
}
