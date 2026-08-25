import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
};

const requiredIdentityEnvironment = {
  BETTER_AUTH_SECRET: "unit-test-auth-secret-at-least-32-characters",
  IDENTITY_DIGEST_SECRET: "unit-test-digest-secret-at-least-32-characters",
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
    return loadCloudConfig({ configPath, env: { ...requiredIdentityEnvironment, ...env } });
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
