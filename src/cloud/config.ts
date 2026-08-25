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
  };
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
    },
  };
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

  return {
    origin: parseOrigin(env.CLOUD_ORIGIN),
    basePath: parseBasePath(env.CLOUD_BASE_PATH),
    host: parseHost(env.CLOUD_HOST),
    port: parseIntegerEnvironment(env, "CLOUD_PORT", 3000, 1, 65535),
    database: {
      connectionString: parseDatabaseUrl(env.DATABASE_URL),
      sslMode,
      max: parseIntegerEnvironment(env, "PG_POOL_MAX", 10, 1, 100),
      idleTimeoutMillis: parseIntegerEnvironment(env, "PG_IDLE_TIMEOUT_MS", 30000, 1000, 600000),
      connectionTimeoutMillis: parseIntegerEnvironment(env, "PG_CONNECTION_TIMEOUT_MS", 5000, 100, 60000),
    },
    product: validateCloudFileConfig(parsed),
  };
}
