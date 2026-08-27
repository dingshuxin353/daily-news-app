import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPostgresPool } from "../../.cloud-dist/src/adapters/postgres/pool.js";
import { createCloudApp } from "../../.cloud-dist/src/cloud/app.js";
import { CloudConfigError, loadCloudConfig } from "../../.cloud-dist/src/cloud/config.js";
import { startCloudServer } from "../../.cloud-dist/src/cloud/server.js";
import { MigrationError, discoverMigrations } from "../../.cloud-dist/src/adapters/postgres/migrations.js";
import {
  FakeMailAdapter,
  TencentSesMailAdapter,
} from "../../.cloud-dist/src/adapters/mail/mail.js";
import {
  IdentityPublicError,
  keyedDigest,
  normalizeEmail,
  resolveTrustedClientIp,
} from "../../.cloud-dist/src/modules/identity/security.js";
import { renderLoginPage } from "../../.cloud-dist/src/web/cloud-pages.js";
import {
  CanonicalJsonError,
  canonicalJson,
  jsonSha256,
} from "../../.cloud-dist/src/modules/shared/canonical-json.js";
import {
  constantTimeDigestEquals,
  derivePairingCode,
  digestAgentTokenSecret,
  digestPairingCode,
  issueAgentToken,
  normalizePairingCode,
  parseAgentToken,
} from "../../.cloud-dist/src/modules/agent-access/token-secret.js";
import {
  assertBrowserMutation,
  createSettingsCsrfToken,
  readSettingsBody,
  resolveTrustedExternalOrigin,
  verifySettingsCsrfToken,
} from "../../.cloud-dist/src/web/settings-security.js";
import { AgentRequestError } from "../../.cloud-dist/src/modules/agent-access/request-policy.js";
import { AgentCredentialService } from "../../.cloud-dist/src/modules/agent-access/credential-service.js";
import { AGENT_API_ROUTE_CONTRACT } from "../../.cloud-dist/src/protocols/http-api/routes.js";

const validProductConfig = {
  schemaVersion: 1,
  defaults: {
    spaceName: "我的日报",
    timeZone: "Asia/Shanghai",
    publicationId: "daily-news",
    publicationName: "DailyNews",
    theme: { id: "newspaper-default", revision: 1 },
    todoEnabled: false,
    priorityLimits: { lead: 1, important: 2, normal: null },
  },
  limits: {
    publicationsPerSpace: 8,
    activeTokensPerUser: 10,
    testDailyEmailHardLimit: 100,
    emailCooldownSeconds: 60,
    emailHourlyLimit: 5,
    ipHourlyLimit: 20,
  },
  identity: {
    otpLength: 6,
    otpExpiresInSeconds: 300,
    otpAllowedAttempts: 3,
    sessionExpiresInDays: 30,
  },
  agentAccess: {
    pairingCodeTtlSeconds: 600,
    provisioningTtlSeconds: 600,
    claimIpHourlyLimit: 20,
    verifyIpHourlyLimit: 40,
    requestBodyLimitBytes: 16384,
    rateLimitRetentionHours: 24,
    auditRetentionDays: 90,
    apiRequestBodyLimitBytes: 262144,
    readTokenHourlyLimit: 600,
    writeTokenHourlyLimit: 120,
    readIpHourlyLimit: 1200,
    writeIpHourlyLimit: 240,
    dailyItemLimit: 100,
    todoOperationLimit: 100,
    concurrentWriteLimitPerSpace: 2,
    writeLeaseTtlSeconds: 300,
    credentialLastUsedTouchSeconds: 300,
    submissionRetentionDays: 90,
  },
};

const requiredIdentityEnvironment = {
  BETTER_AUTH_SECRET: "unit-test-auth-secret-at-least-32-characters",
  IDENTITY_DIGEST_SECRET: "unit-test-digest-secret-at-least-32-characters",
  AGENT_TOKEN_DIGEST_SECRET: "unit-test-agent-token-secret-at-least-32-characters",
  PAIRING_CODE_DIGEST_SECRET: "unit-test-pairing-code-secret-at-least-32-characters",
  MAIL_MODE: "fake",
};

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dailynews-cloud-unit-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function loadWithEnvironment(env) {
  return withTempDirectory(async (directory) => {
    const configPath = path.join(directory, "cloud.json");
    await writeFile(configPath, JSON.stringify(validProductConfig));
    const origin = env.CLOUD_ORIGIN;
    const basePath = env.CLOUD_BASE_PATH || "";
    return loadCloudConfig({
      configPath,
      env: {
        ...requiredIdentityEnvironment,
        AGENT_API_BASE_URL: origin ? `${origin}${basePath}/api/v1` : undefined,
        AGENT_MCP_URL: origin ? `${origin}${basePath}/mcp` : undefined,
        ...env,
      },
    });
  });
}

test("cloud config loads explicit runtime values and loopback defaults", async () => {
  const config = await loadWithEnvironment({
    CLOUD_ORIGIN: "http://127.0.0.1:3100",
    DATABASE_URL: "postgresql://user:placeholder@127.0.0.1:5432/dailynews_test",
  });
  assert.equal(config.origin, "http://127.0.0.1:3100");
  assert.equal(config.basePath, "");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.equal(config.database.sslMode, "disable");
  assert.equal(config.identity.mailMode, "fake");
  assert.equal(config.product.defaults.publicationId, "daily-news");
});

test("cloud config fails closed for missing or unsafe environment", async () => {
  await assert.rejects(
    () => loadWithEnvironment({ DATABASE_URL: "postgresql://user:placeholder@127.0.0.1:5432/dailynews_test" }),
    (error) => error instanceof CloudConfigError && /CLOUD_ORIGIN/.test(error.message),
  );
  await assert.rejects(
    () => loadWithEnvironment({ CLOUD_ORIGIN: "http://example.com", DATABASE_URL: "postgresql://u:p@db:5432/name" }),
    (error) => error instanceof CloudConfigError && /HTTPS/.test(error.message),
  );
  await assert.rejects(
    () => loadWithEnvironment({ CLOUD_ORIGIN: "https://example.com", CLOUD_BASE_PATH: "/cloud/", DATABASE_URL: "postgresql://u:p@db:5432/name" }),
    (error) => error instanceof CloudConfigError && /CLOUD_BASE_PATH/.test(error.message),
  );
  await assert.rejects(
    () => loadWithEnvironment({ CLOUD_ORIGIN: "https://example.com", DATABASE_URL: "https://example.com/not-postgres" }),
    (error) => error instanceof CloudConfigError && /DATABASE_URL/.test(error.message),
  );
  await assert.rejects(
    () => loadWithEnvironment({ CLOUD_ORIGIN: "https://example.com", CLOUD_HOST: "bad host", DATABASE_URL: "postgresql://u:p@db:5432/name" }),
    (error) => error instanceof CloudConfigError && /CLOUD_HOST/.test(error.message),
  );
  await assert.rejects(
    () => loadWithEnvironment({
      CLOUD_ORIGIN: "https://example.com",
      DATABASE_URL: "postgresql://u:p@db:5432/name?sslmode=disable",
      PG_SSL_MODE: "require",
    }),
    (error) => error instanceof CloudConfigError && /SSL parameters/.test(error.message),
  );
});

test("identity configuration fails closed for missing secrets and incomplete SES mode", async () => {
  await withTempDirectory(async (directory) => {
    const configPath = path.join(directory, "cloud.json");
    await writeFile(configPath, JSON.stringify(validProductConfig));
    await assert.rejects(
      () => loadCloudConfig({
        configPath,
        env: {
          CLOUD_ORIGIN: "https://example.com",
          DATABASE_URL: "postgresql://u:p@db:5432/name",
          MAIL_MODE: "fake",
        },
      }),
      (error) => error instanceof CloudConfigError && /BETTER_AUTH_SECRET/.test(error.message),
    );
  });
  await assert.rejects(
    () => loadWithEnvironment({
      CLOUD_ORIGIN: "https://example.com",
      DATABASE_URL: "postgresql://u:p@db:5432/name",
      MAIL_MODE: "ses",
    }),
    (error) => error instanceof CloudConfigError && /TENCENTCLOUD_SECRET_ID/.test(error.message),
  );
});

test("Agent and identity digest secrets must remain independent", async () => {
  await assert.rejects(
    () => loadWithEnvironment({
      CLOUD_ORIGIN: "https://example.com",
      DATABASE_URL: "postgresql://u:p@db:5432/name",
      AGENT_TOKEN_DIGEST_SECRET: requiredIdentityEnvironment.IDENTITY_DIGEST_SECRET,
    }),
    (error) => error instanceof CloudConfigError && /independent/.test(error.message),
  );
});

test("identity configuration requires an explicit non-empty mail mode even when secrets are complete", async () => {
  const baseEnvironment = {
    CLOUD_ORIGIN: "https://example.com",
    DATABASE_URL: "postgresql://u:p@db:5432/name",
  };
  for (const MAIL_MODE of [undefined, ""]) {
    await assert.rejects(
      () => loadWithEnvironment({ ...baseEnvironment, MAIL_MODE }),
      (error) => error instanceof CloudConfigError && /MAIL_MODE/.test(error.message),
    );
  }
});

test("identity security normalizes accounts, digests identifiers, and trusts only a loopback proxy", () => {
  assert.equal(normalizeEmail("  USER@Example.COM "), "user@example.com");
  assert.throws(
    () => normalizeEmail("not-an-email"),
    (error) => error instanceof IdentityPublicError && error.status === 400,
  );
  assert.match(keyedDigest("digest-secret", "user@example.com"), /^[0-9a-f]{64}$/);
  assert.equal(resolveTrustedClientIp({
    remoteAddress: "127.0.0.1",
    forwardedAddress: "203.0.113.8",
  }), "203.0.113.8");
  assert.equal(resolveTrustedClientIp({
    remoteAddress: "198.51.100.3",
    forwardedAddress: "203.0.113.8",
  }), "198.51.100.3");
  assert.equal(resolveTrustedClientIp({
    remoteAddress: "127.0.0.1",
    forwardedAddress: "203.0.113.8, 198.51.100.3",
  }), "127.0.0.1");
});

test("mail adapters keep Fake delivery in memory and require both SES identifiers", async () => {
  const fake = new FakeMailAdapter();
  await fake.send({ email: "user@example.com", otp: "123456", expiresInMinutes: 5 });
  assert.equal(fake.latestFor("user@example.com")?.otp, "123456");

  let captured;
  const config = {
    secretId: "placeholder-id",
    secretKey: "placeholder-key",
    region: "ap-guangzhou",
    fromEmailAddress: "sender@example.com",
    templateId: 123,
    subject: "DailyNews 登录验证码",
  };
  const ses = new TencentSesMailAdapter(config, {
    async SendEmail(input) {
      captured = input;
      return { RequestId: "request-id", MessageId: "message-id" };
    },
  });
  assert.deepEqual(await ses.send({ email: "user@example.com", otp: "654321", expiresInMinutes: 5 }), {
    requestId: "request-id",
    messageId: "message-id",
  });
  assert.equal(captured.TriggerType, 1);
  assert.deepEqual(captured.Destination, ["user@example.com"]);
  assert.equal(JSON.parse(captured.Template.TemplateData).code, "654321");

  const invalidSes = new TencentSesMailAdapter(config, {
    async SendEmail() {
      return { RequestId: "request-only" };
    },
  });
  await assert.rejects(() => invalidSes.send({ email: "user@example.com", otp: "000000", expiresInMinutes: 5 }));
});

test("login page contains no account-discovery copy or persistent email storage", () => {
  const html = renderLoginPage("/cloud");
  assert.match(html, /\/cloud\/assets\/cloud-auth\.js/);
  assert.match(html, /autocomplete="email"/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|邮箱不存在|已注册/);
});

test("PG_SSL_MODE is the authoritative pg Pool TLS setting", async () => {
  const required = await loadWithEnvironment({
    CLOUD_ORIGIN: "https://example.com",
    DATABASE_URL: "postgresql://u:p@db:5432/name?application_name=test",
    PG_SSL_MODE: "require",
  });
  const requiredPool = createPostgresPool(required.database);
  try {
    assert.deepEqual(requiredPool.options.ssl, { rejectUnauthorized: true });
    assert.equal(requiredPool.options.connectionString, required.database.connectionString);
  } finally {
    await requiredPool.end();
  }

  const disabled = await loadWithEnvironment({
    CLOUD_ORIGIN: "https://example.com",
    DATABASE_URL: "postgresql://u:p@db:5432/name",
    PG_SSL_MODE: "disable",
  });
  const disabledPool = createPostgresPool(disabled.database);
  try {
    assert.equal(disabledPool.options.ssl, false);
  } finally {
    await disabledPool.end();
  }
});

test("cloud config rejects malformed committed defaults", async () => {
  await withTempDirectory(async (directory) => {
    const configPath = path.join(directory, "cloud.json");
    await writeFile(configPath, JSON.stringify({ ...validProductConfig, schemaVersion: 2 }));
    await assert.rejects(
      () => loadCloudConfig({
        configPath,
        env: {
          ...requiredIdentityEnvironment,
          CLOUD_ORIGIN: "https://example.com",
          DATABASE_URL: "postgresql://u:p@db:5432/name",
          AGENT_API_BASE_URL: "https://example.com/api/v1",
          AGENT_MCP_URL: "https://example.com/mcp",
        },
      }),
      (error) => error instanceof CloudConfigError && /schemaVersion/.test(error.message),
    );
  });
});

test("liveness never calls readiness and readiness recovers without leaking errors", async () => {
  let ready = false;
  let readinessCalls = 0;
  const app = createCloudApp({
    basePath: "",
    readinessCheck: async () => {
      readinessCalls += 1;
      if (!ready) throw new Error("password=private sql=SELECT secret FROM users");
    },
  });

  const liveResponse = await app.request("http://localhost/health/live");
  assert.equal(liveResponse.status, 200);
  assert.deepEqual(await liveResponse.json(), { status: "ok" });
  assert.equal(readinessCalls, 0);

  const unavailableResponse = await app.request("http://localhost/health/ready");
  assert.equal(unavailableResponse.status, 503);
  const unavailableBody = await unavailableResponse.text();
  assert.deepEqual(JSON.parse(unavailableBody), { status: "unavailable" });
  assert.doesNotMatch(unavailableBody, /private|SELECT|users/);

  ready = true;
  const readyResponse = await app.request("http://localhost/health/ready");
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), { status: "ready" });
});

test("health routes honor the explicit base path", async () => {
  const app = createCloudApp({ basePath: "/cloud", readinessCheck: async () => {} });
  assert.equal((await app.request("http://localhost/health/live")).status, 404);
  assert.equal((await app.request("http://localhost/cloud/health/live")).status, 200);
});

function runtimeConfig(port) {
  return {
    origin: "http://127.0.0.1",
    basePath: "",
    host: "127.0.0.1",
    port,
    database: {
      connectionString: "postgresql://u:p@127.0.0.1:5432/dailynews_test",
      sslMode: "disable",
      max: 1,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 100,
    },
    identity: {
      authSecret: requiredIdentityEnvironment.BETTER_AUTH_SECRET,
      digestSecret: requiredIdentityEnvironment.IDENTITY_DIGEST_SECRET,
      mailMode: "fake",
    },
    agentAccess: {
      tokenDigestSecret: requiredIdentityEnvironment.AGENT_TOKEN_DIGEST_SECRET,
      pairingCodeDigestSecret: requiredIdentityEnvironment.PAIRING_CODE_DIGEST_SECRET,
      apiBaseUrl: "http://127.0.0.1/api/v1",
      mcpUrl: "http://127.0.0.1/mcp",
    },
    product: validProductConfig,
  };
}

async function closeHttpServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("cloud startup rejects occupied ports instead of resolving early", async () => {
  const blocker = createServer((_request, response) => response.end("occupied"));
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(
      () => startCloudServer({ config: runtimeConfig(address.port) }),
      (error) => error?.code === "EADDRINUSE",
    );
  } finally {
    await closeHttpServer(blocker);
  }
});

test("cloud startup waits for listening and immediate close leaves no live server", async () => {
  const runtime = await startCloudServer({ config: runtimeConfig(0) });
  const url = `http://127.0.0.1:${runtime.address.port}/health/live`;
  assert.equal((await fetch(url)).status, 200);
  await runtime.close();
  await runtime.close();
  await assert.rejects(() => fetch(url));
});

test("migration discovery sorts numeric prefixes and hashes exact content", async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, "0002_second.sql"), "SELECT 2;\n");
    await writeFile(path.join(directory, "0001_first.sql"), "SELECT 1;\n");
    const migrations = await discoverMigrations(directory);
    assert.deepEqual(migrations.map(({ filename }) => filename), ["0001_first.sql", "0002_second.sql"]);
    assert.match(migrations[0].checksum, /^[0-9a-f]{64}$/);
    assert.equal(migrations[0].sql, "SELECT 1;\n");
  });
});

test("migration discovery rejects malformed names and duplicate sequences", async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, "migration.sql"), "SELECT 1;");
    await assert.rejects(
      () => discoverMigrations(directory),
      (error) => error instanceof MigrationError && error.code === "MIGRATION_SET_INVALID",
    );
  });
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, "0001_first.sql"), "SELECT 1;");
    await writeFile(path.join(directory, "0001_second.sql"), "SELECT 2;");
    await assert.rejects(
      () => discoverMigrations(directory),
      (error) => error instanceof MigrationError && error.code === "MIGRATION_SET_INVALID",
    );
  });
});

test("canonical JSON hashes equivalent inputs identically and rejects unsupported values", () => {
  const first = { mode: "update", candidate: { date: "2026-08-25", items: [1, true, null] } };
  const second = { candidate: { items: [1, true, null], date: "2026-08-25" }, mode: "update" };
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(jsonSha256(first), jsonSha256(second));
  assert.match(jsonSha256(first), /^[0-9a-f]{64}$/);

  assert.throws(
    () => canonicalJson({ candidate: undefined }),
    (error) => error instanceof CanonicalJsonError && error.code === "CANONICAL_JSON_INVALID",
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), CanonicalJsonError);
});

test("PAT format locks a 128-bit selector, 256-bit secret, and digest-only verification", () => {
  const digestSecret = "agent-token-unit-secret-with-at-least-32-characters";
  const issued = issueAgentToken(digestSecret);
  assert.match(issued.token, /^dnpat_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
  assert.match(issued.secretDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(issued.hint, new RegExp(issued.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const parsed = parseAgentToken(issued.token);
  assert.ok(parsed);
  const received = digestAgentTokenSecret(digestSecret, parsed.selector, parsed.secret);
  assert.ok(constantTimeDigestEquals(issued.secretDigest, received));
  assert.equal(parseAgentToken(`${issued.token}x`), null);
  assert.equal(parseAgentToken("dnpat_short_secret"), null);
  assert.equal(constantTimeDigestEquals(issued.secretDigest, "0".repeat(64)), false);
  assert.equal(new Set(Array.from({ length: 100 }, () => issueAgentToken(digestSecret).token)).size, 100);
});

test("active PAT authentication treats the Bearer scheme case-insensitively and rejects provisioning credentials", async () => {
  const tokenDigestSecret = "active-token-unit-secret-with-at-least-32-characters";
  const issued = issueAgentToken(tokenDigestSecret);
  const credential = {
    id: "00000000-0000-4000-8000-000000000001",
    spaceId: "00000000-0000-4000-8000-000000000002",
    name: "Unit Agent",
    selector: issued.selector,
    secretDigest: issued.secretDigest,
    tokenHint: issued.hint,
    status: "active",
    rotatedFromId: null,
    expiresAt: null,
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };
  const service = new AgentCredentialService({
    async findCredentialBySelector(selector) {
      return selector === issued.selector ? credential : null;
    },
  }, {
    tokenDigestSecret,
    pairingCodeDigestSecret: "pairing-unit-secret-with-at-least-32-characters",
    activeCredentialLimit: 10,
    pairingCodeTtlSeconds: 600,
    provisioningTtlSeconds: 600,
    claimIpHourlyLimit: 20,
    verifyIpHourlyLimit: 40,
    apiBaseUrl: "https://example.com/api/v1",
    mcpUrl: "https://example.com/mcp",
    pairingVerifyUrl: "https://example.com/agent-pairing/v1/verify",
  });
  assert.equal((await service.authenticateActiveToken(`bearer ${issued.token}`)).id, credential.id);
  credential.status = "provisioning";
  await assert.rejects(() => service.authenticateActiveToken(`Bearer ${issued.token}`), (error) => error.status === 401);
});

test("pairing codes are stable per generation, refreshable, normalized, and digest-only", () => {
  const secret = "pairing-code-unit-secret-with-at-least-32-characters";
  const pairingId = "f4dc55ba-5555-4555-8555-555555555555";
  const first = derivePairingCode(secret, pairingId, 1);
  assert.match(first, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
  assert.equal(first, derivePairingCode(secret, pairingId, 1));
  assert.notEqual(first, derivePairingCode(secret, pairingId, 2));
  const normalized = normalizePairingCode(first.toLowerCase().replace("-", " "));
  assert.ok(normalized);
  assert.match(digestPairingCode(secret, normalized), /^[0-9a-f]{64}$/);
  assert.equal(normalizePairingCode("00000-00000"), null);
});

test("settings CSRF tokens bind to one session and user", () => {
  const secret = "settings-csrf-unit-secret-with-at-least-32-characters";
  const token = createSettingsCsrfToken(secret, "session-a", "user-a");
  assert.ok(verifySettingsCsrfToken(secret, "session-a", "user-a", token));
  assert.equal(verifySettingsCsrfToken(secret, "session-b", "user-a", token), false);
  assert.equal(verifySettingsCsrfToken(secret, "session-a", "user-b", token), false);
  assert.equal(verifySettingsCsrfToken(secret, "session-a", "user-a", `${token}x`), false);
});

test("settings mutations reject cross-origin, invalid CSRF, unsupported media, and streamed overflow", async () => {
  const secret = "settings-request-secret-with-at-least-32-characters";
  const csrf = createSettingsCsrfToken(secret, "session-a", "user-a");
  const validRequest = new Request("https://dailynews.test/settings/agent/connections", {
    method: "POST",
    headers: { origin: "https://dailynews.test", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, name: "Agent" }),
  });
  const body = await readSettingsBody(validRequest.clone(), 1024);
  assert.deepEqual(body, { _csrf: csrf, name: "Agent" });
  assert.doesNotThrow(() => assertBrowserMutation({
    request: validRequest,
    requestOrigin: "https://dailynews.test",
    configuredOrigin: "https://dailynews.test",
    csrfSecret: secret,
    sessionId: "session-a",
    userId: "user-a",
    body,
  }));
  assert.throws(() => assertBrowserMutation({
    request: new Request(validRequest, { headers: { ...Object.fromEntries(validRequest.headers), origin: "https://attacker.test" } }),
    requestOrigin: "https://dailynews.test",
    configuredOrigin: "https://dailynews.test",
    csrfSecret: secret,
    sessionId: "session-a",
    userId: "user-a",
    body,
  }), (error) => error.status === 403);
  await assert.rejects(
    () => readSettingsBody(new Request("https://dailynews.test/", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "plain",
    }), 1024),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => readSettingsBody(new Request("https://dailynews.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(2048) }),
    }), 1024),
    (error) => error.status === 400,
  );
});

test("external origin trusts one loopback TLS proxy hop and rejects untrusted forwarding", () => {
  assert.equal(resolveTrustedExternalOrigin({
    requestUrl: "http://dailynews.test/settings/agent/connections",
    requestHost: "dailynews.test",
    transportProtocol: "http",
    configuredOrigin: "https://dailynews.test",
    remoteAddress: "127.0.0.1",
    forwardedProto: "https",
  }), "https://dailynews.test");
  for (const input of [
    { remoteAddress: "203.0.113.20", forwardedProto: "https" },
    { remoteAddress: "127.0.0.1", forwardedProto: undefined },
    { remoteAddress: "127.0.0.1", forwardedProto: "https,http" },
    { remoteAddress: "127.0.0.1", forwardedProto: "http" },
  ]) {
    assert.equal(resolveTrustedExternalOrigin({
      requestUrl: "http://dailynews.test/settings/agent/connections",
      requestHost: "dailynews.test",
      transportProtocol: "http",
      configuredOrigin: "https://dailynews.test",
      ...input,
    }), "http://dailynews.test");
  }
  assert.equal(resolveTrustedExternalOrigin({
    requestUrl: "https://dailynews.test/settings/agent/connections",
    requestHost: "dailynews.test",
    transportProtocol: "http",
    configuredOrigin: "https://dailynews.test",
    remoteAddress: "127.0.0.1",
    forwardedProto: undefined,
  }), "http://dailynews.test");
  assert.equal(resolveTrustedExternalOrigin({
    requestUrl: "https://dailynews.test/settings/agent/connections",
    requestHost: "dailynews.test",
    transportProtocol: "https",
    configuredOrigin: "https://dailynews.test",
    remoteAddress: "203.0.113.20",
    forwardedProto: undefined,
  }), "https://dailynews.test");
  for (const mismatch of [
    { requestUrl: "https://dailynews.test/settings/agent/connections", requestHost: "attacker.test" },
    { requestUrl: "https://attacker.test/settings/agent/connections", requestHost: "dailynews.test" },
  ]) {
    assert.equal(resolveTrustedExternalOrigin({
      ...mismatch,
      transportProtocol: "http",
      configuredOrigin: "https://dailynews.test",
      remoteAddress: "127.0.0.1",
      forwardedProto: "https",
    }), null);
  }
});

test("HTTP adapter enforces the loopback TLS terminator and accepts bodyless PAT verification", async () => {
  const csrfSecret = "adapter-csrf-secret-with-at-least-32-characters";
  const session = { session: { id: "session-a" }, user: { id: "user-a" } };
  const renamed = [];
  const app = createCloudApp({
    basePath: "",
    readinessCheck: async () => {},
    identity: { getSession: async () => session },
    tenancy: { ensureSpaceForUser: async () => ({ spaceId: "space-a", userId: "user-a" }) },
    defaults: validProductConfig.defaults,
    agentSettings: {
      origin: "https://dailynews.test",
      csrfSecret,
      service: {
        ensureBootstrapPairing: async () => {},
        verifyPairing: async () => ({
          credential: {
            id: "credential-pairing",
            spaceId: "space-a",
            name: "Provisioned Agent",
            selector: "selector",
            secretDigest: "digest",
            tokenHint: "hint",
            status: "active",
            rotatedFromId: null,
            expiresAt: null,
            createdAt: new Date("2026-08-27T00:00:00.000Z"),
            lastUsedAt: new Date("2026-08-27T00:00:00.000Z"),
            revokedAt: null,
          },
          context: {
            publicationId: "daily-news",
            publicationName: "DailyNews",
            timeZone: "Asia/Shanghai",
            todoEnabled: false,
          },
        }),
        renameCredential: async (_tenant, id, name) => {
          renamed.push({ id, name });
          return {
            id,
            spaceId: "space-a",
            name,
            selector: "selector",
            secretDigest: "digest",
            tokenHint: "hint",
            status: "active",
            rotatedFromId: null,
            expiresAt: null,
            createdAt: new Date("2026-08-27T00:00:00.000Z"),
            lastUsedAt: null,
            revokedAt: null,
          };
        },
      },
      digestActor: () => "actor-digest",
      apiBaseUrl: "https://dailynews.test/api/v1",
      mcpUrl: "https://dailynews.test/mcp",
      activeCredentialLimit: 10,
      requestBodyLimitBytes: 16384,
    },
  });
  const server = createAdaptorServer({ fetch: app.fetch, hostname: "127.0.0.1" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const csrf = createSettingsCsrfToken(csrfSecret, "session-a", "user-a");
  const noSocketRequest = (host) => app.request(
    "https://dailynews.test/settings/agent/connections/credential-a/name",
    {
      method: "POST",
      headers: {
        host,
        origin: "https://dailynews.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "无连接上下文", _csrf: csrf }),
    },
  );
  const request = (headers = {}, requestTarget = "/settings/agent/connections/credential-a/name") => new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: "代理后的 Agent", _csrf: csrf });
    const outgoing = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path: requestTarget,
      method: "POST",
      headers: {
        host: "dailynews.test",
        origin: "https://dailynews.test",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...headers,
      },
    }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve(incoming.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
  const verifyRequest = () => new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/agent-pairing/v1/verify",
      method: "POST",
      headers: { authorization: "Bearer provisioning-token" },
    }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve(incoming.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
  try {
    assert.equal((await noSocketRequest("dailynews.test")).status, 403);
    assert.equal((await noSocketRequest("attacker.test")).status, 403);
    assert.equal(await request(), 403);
    assert.equal(await request({ "x-forwarded-proto": "http" }), 403);
    assert.equal(await request({ "x-forwarded-proto": "https", origin: "https://attacker.test" }), 403);
    assert.equal(await request(
      {},
      "https://dailynews.test/settings/agent/connections/credential-a/name",
    ), 403);
    assert.equal(await request(
      { "x-forwarded-proto": "https", host: "attacker.test" },
      "https://dailynews.test/settings/agent/connections/credential-a/name",
    ), 403);
    assert.equal(await request({ "x-forwarded-proto": "https" }), 200);
    assert.equal(await verifyRequest(), 200);
    assert.deepEqual(renamed, [{ id: "credential-a", name: "代理后的 Agent" }]);
  } finally {
    await closeHttpServer(server);
  }
});

function agentApiTestApp(overrides = {}) {
  const calls = [];
  const access = {
    requestId: "req_test",
    credentialId: "credential-test",
    credentialName: "测试 Agent",
    tenant: { spaceId: "space-test", userId: "user-test" },
  };
  const operations = {
    async listPublications() {
      return { publications: [{ publicationId: "daily-news", name: "DailyNews", isDefault: true, status: "active", writable: true }] };
    },
    async getDailyContext(_access, publicationId, date) {
      return { publicationId, resolvedDate: date ?? "2026-08-27" };
    },
    async submitDailyCandidate(_access, input) {
      calls.push({ type: "daily", input });
      return { result: "created", revision: 1 };
    },
    async getDailyIssue(_access, publicationId, date) {
      return { publicationId, date, revision: 1 };
    },
    async getTodoContext() {
      return { enabled: false, settingsUrl: "https://dailynews.test/settings/todo" };
    },
    async getTodo() {
      return { enabled: false, settingsUrl: "https://dailynews.test/settings/todo" };
    },
    async getTodoState() {
      throw new Error("disabled Todo must not be read");
    },
    async submitTodoCandidate(_access, input) {
      calls.push({ type: "todo", input });
      return { result: "published", revision: 1 };
    },
    ...overrides.operations,
  };
  const app = createCloudApp({
    basePath: "/cloud",
    readinessCheck: async () => {},
    clientIpResolver: () => "203.0.113.10",
    agentApi: {
      requestBodyLimitBytes: overrides.requestBodyLimitBytes ?? 1024,
      authenticator: {
        async authenticate(input) {
          calls.push({ type: "authenticate", input });
          if (input.authorization !== "Bearer valid-token") {
            throw new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
          }
          return { ...access, requestId: input.requestId };
        },
      },
      operations,
    },
  });
  return { app, calls };
}

test("JSON API authenticates Bearer PATs, keeps GET bodyless, and returns private structured responses", async () => {
  const { app, calls } = agentApiTestApp();
  const response = await app.request("https://dailynews.test/cloud/api/v1/publications", {
    headers: { authorization: "Bearer valid-token" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-request-id"), /^req_[0-9a-f]{32}$/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json();
  assert.equal(body.publications[0].publicationId, "daily-news");
  assert.equal(calls[0].input.action, "read");
  assert.equal(calls[0].input.clientIp, "203.0.113.10");
});

test("JSON API requires PAT independently from browser Cookie and returns the stable error envelope", async () => {
  const { app } = agentApiTestApp();
  const response = await app.request("https://dailynews.test/cloud/api/v1/publications", {
    headers: { cookie: "better-auth.session_token=browser-only" },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  const body = await response.json();
  assert.equal(body.error.code, "invalid_token");
  assert.match(body.error.requestId, /^req_[0-9a-f]{32}$/);
});

test("JSON API validates POST media type, idempotency key, strict envelopes, and streamed size", async () => {
  const { app, calls } = agentApiTestApp({ requestBodyLimitBytes: 256 });
  const url = "https://dailynews.test/cloud/api/v1/publications/daily-news/daily-candidates";
  const body = JSON.stringify({
    mode: "update",
    confirmation: { historicalDate: null, replace: null },
    candidate: { schemaVersion: 2 },
  });
  const success = await app.request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": "daily-run-0001",
    },
    body,
  });
  assert.equal(success.status, 200);
  assert.equal(calls.find(({ type }) => type === "daily").input.clientRunId, "daily-run-0001");

  const missingKey = await app.request(url, {
    method: "POST",
    headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
    body,
  });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "invalid_request");

  const unsupported = await app.request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "text/plain",
      "idempotency-key": "daily-run-0002",
    },
    body,
  });
  assert.equal(unsupported.status, 400);

  const oversized = await app.request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      "idempotency-key": "daily-run-0003",
    },
    body: JSON.stringify({ candidate: { text: "x".repeat(1000) } }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "payload_too_large");
});

test("JSON API omits retained Todo state when Personal Todo is disabled", async () => {
  const { app } = agentApiTestApp();
  const response = await app.request("https://dailynews.test/cloud/api/v1/todo", {
    headers: { authorization: "Bearer valid-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()).sort(), ["enabled", "requestId", "settingsUrl"]);
});

test("OpenAPI 3.1 stays aligned with the real routes, auth, idempotency, errors, and fake examples", async () => {
  const specification = JSON.parse(await readFile(path.join(process.cwd(), "docs", "openapi-v1.yaml"), "utf8"));
  assert.equal(specification.openapi, "3.1.0");
  assert.deepEqual(specification.security, [{ bearerAuth: [] }]);
  const documented = Object.entries(specification.paths)
    .flatMap(([routePath, methods]) => Object.keys(methods).map((method) => ({ method, path: routePath })))
    .sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
  const { app } = agentApiTestApp();
  const registered = app.routes
    .filter(({ path: routePath }) => routePath.startsWith("/cloud/api/v1"))
    .map(({ method, path: routePath }) => ({
      method: method.toLowerCase(),
      path: routePath
        .slice("/cloud/api/v1".length)
        .replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}"),
    }))
    .sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
  const implemented = [...AGENT_API_ROUTE_CONTRACT]
    .sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
  assert.deepEqual(documented, implemented);
  assert.deepEqual(registered, implemented);
  for (const { path: routePath, method } of AGENT_API_ROUTE_CONTRACT.filter(({ method }) => method === "post")) {
    const operation = specification.paths[routePath][method];
    assert.ok(operation.parameters.some(({ $ref }) => $ref === "#/components/parameters/IdempotencyKey"));
    assert.ok(operation.requestBody.content["application/json"].example);
    assert.ok(operation.responses["413"]);
  }
  const errorCodes = specification.components.schemas.Error.properties.error.properties.code.enum;
  for (const code of [
    "invalid_token", "idempotency_conflict", "revision_conflict", "explicit_confirmation_required",
    "publication_inactive", "todo_disabled", "payload_too_large", "rate_limited", "service_unavailable",
  ]) assert.ok(errorCodes.includes(code));

  const guide = await readFile(path.join(process.cwd(), "docs", "CLOUD_AGENT_ACCESS.md"), "utf8");
  assert.match(guide, /daily-candidates/);
  assert.match(guide, /todo\/candidates/);
  assert.match(guide, /Idempotency-Key/);
  assert.doesNotMatch(guide, /dnpat_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/);
});
