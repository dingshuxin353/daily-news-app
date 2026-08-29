import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import pg from "pg";
import { createCloudApp } from "../../.cloud-dist/src/cloud/app.js";
import { runMigrations } from "../../.cloud-dist/src/adapters/postgres/migrations.js";
import {
  createAuthPostgresPool,
  createPostgresPool,
} from "../../.cloud-dist/src/adapters/postgres/pool.js";
import { PostgresTenancyStore } from "../../.cloud-dist/src/adapters/postgres/tenancy.js";
import { FakeMailAdapter } from "../../.cloud-dist/src/adapters/mail/mail.js";
import { createIdentityService } from "../../.cloud-dist/src/modules/identity/auth.js";
import { PrivateReadingService } from "../../.cloud-dist/src/modules/private-reading/service.js";
import { createFileThemeStorage } from "../../scripts/lib/storage/file-theme.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
if (!/(?:test|ci)/i.test(databaseName)) {
  throw new Error("PostgreSQL integration tests require a dedicated test or CI database");
}

const { Pool } = pg;
const controlPool = new Pool({ connectionString, max: 20, connectionTimeoutMillis: 5000 });
const openHarnesses = new Set();
const migrationsDirectory = new URL("../../db/migrations", import.meta.url).pathname;
const projectRoot = new URL("../../", import.meta.url).pathname;
const systemThemes = createFileThemeStorage({ rootDir: projectRoot });

const product = {
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
  },
};

function runtimeConfig(productOverrides = {}) {
  return {
    origin: "https://dailynews.test",
    basePath: "",
    host: "127.0.0.1",
    port: 0,
    database: {
      connectionString,
      sslMode: "disable",
      max: 10,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 5000,
    },
    identity: {
      authSecret: "identity-integration-auth-secret-32-characters",
      digestSecret: "identity-integration-digest-secret-32-characters",
      mailMode: "fake",
    },
    agentAccess: {
      tokenDigestSecret: "identity-integration-agent-secret-32-characters",
      pairingCodeDigestSecret: "identity-integration-pairing-secret-32-characters",
      apiBaseUrl: "https://dailynews.test/api/v1",
      mcpUrl: "https://dailynews.test/mcp",
    },
    product: {
      ...product,
      ...productOverrides,
      limits: { ...product.limits, ...productOverrides.limits },
      identity: { ...product.identity, ...productOverrides.identity },
    },
  };
}

function createHarness(options = {}) {
  const config = runtimeConfig(options.productOverrides);
  const appPool = createPostgresPool(config.database);
  const authPool = createAuthPostgresPool(config.database);
  const fakeMail = options.fakeMail ?? new FakeMailAdapter();
  const identity = createIdentityService({ config, appPool, authPool, mailAdapter: fakeMail });
  const tenancy = new PostgresTenancyStore(appPool);
  const app = createCloudApp({
    basePath: config.basePath,
    readinessCheck: async () => {},
    identity,
    tenancy,
    privateReading: new PrivateReadingService(appPool, tenancy, systemThemes),
    defaults: config.product.defaults,
    clientIpResolver: (context) => context.req.header("x-test-client-ip") || "127.0.0.1",
    testMailReader: options.exposeFake === false ? undefined : fakeMail,
  });
  const harness = {
    app,
    appPool,
    authPool,
    fakeMail,
    async close() {
      openHarnesses.delete(harness);
      await Promise.all([appPool.end(), authPool.end()]);
    },
  };
  openHarnesses.add(harness);
  return harness;
}

async function resetAndMigrate() {
  await controlPool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await controlPool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await runMigrations(controlPool, { migrationsDirectory });
}

async function post(app, pathname, body, headers = {}) {
  return app.request(`https://dailynews.test${pathname}`, {
    method: "POST",
    headers: {
      origin: "https://dailynews.test",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function sendOtp(harness, email, headers = {}) {
  return post(harness.app, "/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  }, headers);
}

async function latestOtp(harness, email) {
  const response = await harness.app.request(
    `https://dailynews.test/__test__/mail/latest?email=${encodeURIComponent(email)}`,
  );
  assert.equal(response.status, 200);
  return (await response.json()).otp;
}

async function verifyOtp(harness, email, otp, headers = {}) {
  return post(harness.app, "/api/auth/sign-in/email-otp", { email, otp }, headers);
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "sign-in must set a session cookie");
  return setCookie.split(";", 1)[0];
}

beforeEach(resetAndMigrate);

afterEach(async () => {
  await Promise.all([...openHarnesses].map((harness) => harness.close()));
});

after(async () => {
  await controlPool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await controlPool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await controlPool.end();
});

test("Fake mode completes OTP sign-in, bootstraps one Space, persists the session, and signs out", async () => {
  const firstRuntime = createHarness();
  const email = "first@example.com";
  assert.equal((await sendOtp(firstRuntime, email)).status, 200);
  const otp = await latestOtp(firstRuntime, email);
  const verification = await controlPool.query('SELECT "value" FROM auth."verification"');
  assert.equal(verification.rowCount, 1);
  assert.doesNotMatch(verification.rows[0].value, new RegExp(otp));

  const secondRuntime = createHarness({ exposeFake: false });
  const signIn = await verifyOtp(secondRuntime, email, otp);
  assert.equal(signIn.status, 200);
  const cookie = sessionCookie(signIn);
  const setCookie = signIn.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);

  const publicPage = await secondRuntime.app.request("https://dailynews.test/", {
    headers: { cookie },
  });
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /进入私人日报/);

  const destination = await secondRuntime.app.request("https://dailynews.test/post-login", {
    headers: { cookie },
  });
  assert.equal(destination.status, 303);
  assert.equal(destination.headers.get("location"), "/onboarding");

  const privatePage = await secondRuntime.app.request("https://dailynews.test/home", {
    headers: { cookie },
  });
  assert.equal(privatePage.status, 200);
  const html = await privatePage.text();
  assert.match(html, /示例日报/);
  assert.match(html, /设置自动日报/);
  assert.match(html, /data-theme-id="newspaper-default"/);
  assert.doesNotMatch(html, /下次更新时间|负责 Agent|调度健康|迟到/);
  assert.equal(privatePage.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(privatePage.headers.get("cache-control"), "private, no-store");

  const counts = await controlPool.query(`
    SELECT
      (SELECT count(*)::integer FROM auth."user") AS users,
      (SELECT count(*)::integer FROM auth."session") AS sessions,
      (SELECT count(*)::integer FROM app.spaces) AS spaces,
      (SELECT count(*)::integer FROM app.home_profiles) AS homes,
      (SELECT count(*)::integer FROM app.publications) AS publications
  `);
  assert.deepEqual(counts.rows[0], { users: 1, sessions: 1, spaces: 1, homes: 1, publications: 1 });

  const signOut = await post(secondRuntime.app, "/api/auth/sign-out", {}, { cookie });
  assert.equal(signOut.status, 200);
  const afterSignOut = await secondRuntime.app.request("https://dailynews.test/home", { headers: { cookie } });
  assert.equal(afterSignOut.status, 303);
  assert.equal(afterSignOut.headers.get("location"), "/login?returnTo=%2Fhome");
});

test("generic Better Auth profile mutation cannot bypass the explicit nickname service", async () => {
  const harness = createHarness();
  const email = "nickname-boundary@example.com";
  assert.equal((await sendOtp(harness, email)).status, 200);
  const cookie = sessionCookie(await verifyOtp(harness, email, await latestOtp(harness, email)));
  const before = (await controlPool.query(
    `SELECT "id", "name", "image" FROM auth."user" WHERE "email" = $1`,
    [email],
  )).rows[0];

  const bypass = await post(harness.app, "/api/auth/update-user", {
    name: "Bypassed Nickname",
    image: "https://example.test/avatar.png",
  }, { cookie });
  assert.equal(bypass.status, 404);
  assert.deepEqual((await controlPool.query(
    `SELECT "id", "name", "image" FROM auth."user" WHERE "email" = $1`,
    [email],
  )).rows[0], before);
  assert.equal((await controlPool.query(
    "SELECT count(*)::integer AS count FROM app.user_profiles WHERE user_id = $1",
    [before.id],
  )).rows[0].count, 0);
});

test("Better Auth retains server-side revocation of every session for the current user", async () => {
  const harness = createHarness();
  const email = "revoke-all@example.com";
  assert.equal((await sendOtp(harness, email)).status, 200);
  const firstCookie = sessionCookie(await verifyOtp(harness, email, await latestOtp(harness, email)));

  await controlPool.query(
    "UPDATE app.login_send_attempts SET created_at = created_at - interval '2 minutes' WHERE email_hash IS NOT NULL",
  );
  assert.equal((await sendOtp(harness, email)).status, 200);
  const secondCookie = sessionCookie(await verifyOtp(harness, email, await latestOtp(harness, email)));
  assert.equal(
    (await controlPool.query('SELECT count(*)::integer AS count FROM auth."session"')).rows[0].count,
    2,
  );

  const revoked = await post(harness.app, "/api/auth/revoke-sessions", {}, { cookie: firstCookie });
  assert.equal(revoked.status, 200);
  assert.equal(
    (await controlPool.query('SELECT count(*)::integer AS count FROM auth."session"')).rows[0].count,
    0,
  );
  for (const cookie of [firstCookie, secondCookie]) {
    const privatePage = await harness.app.request("https://dailynews.test/home", { headers: { cookie } });
    assert.equal(privatePage.status, 303);
    assert.equal(privatePage.headers.get("location"), "/login?returnTo=%2Fhome");
  }
});

test("OTP attempts, rotation, one-time consumption, and concurrent verification fail closed", async () => {
  const harness = createHarness();
  const attemptsEmail = "attempts@example.com";
  assert.equal((await sendOtp(harness, attemptsEmail)).status, 200);
  const attemptsOtp = await latestOtp(harness, attemptsEmail);
  const wrongOtp = attemptsOtp === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.notEqual((await verifyOtp(harness, attemptsEmail, wrongOtp)).status, 200);
  }
  assert.notEqual((await verifyOtp(harness, attemptsEmail, attemptsOtp)).status, 200);

  const rotateEmail = "rotate@example.com";
  assert.equal((await sendOtp(harness, rotateEmail)).status, 200);
  const oldOtp = await latestOtp(harness, rotateEmail);
  await controlPool.query(
    "UPDATE app.login_send_attempts SET created_at = created_at - interval '2 minutes' WHERE email_hash IS NOT NULL",
  );
  assert.equal((await sendOtp(harness, rotateEmail)).status, 200);
  const newOtp = await latestOtp(harness, rotateEmail);
  assert.notEqual(oldOtp, newOtp);
  assert.notEqual((await verifyOtp(harness, rotateEmail, oldOtp)).status, 200);

  const concurrent = await Promise.all([
    verifyOtp(harness, rotateEmail, newOtp),
    verifyOtp(harness, rotateEmail, newOtp),
  ]);
  const concurrentResults = await Promise.all(concurrent.map(async (response) => ({
    status: response.status,
    body: await response.clone().text(),
  })));
  assert.equal(
    concurrent.filter((response) => response.status === 200).length,
    1,
    JSON.stringify(concurrentResults),
  );
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM auth.\"user\"")).rows[0].count, 1);
});

test("persistent email cooldown survives a new identity runtime", async () => {
  const firstRuntime = createHarness();
  assert.equal((await sendOtp(firstRuntime, "limited@example.com")).status, 200);
  const secondRuntime = createHarness({ exposeFake: false });
  const limited = await sendOtp(secondRuntime, " LIMITED@EXAMPLE.COM ", { "x-test-client-ip": "203.0.113.4" });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: { code: "rate_limited" } });
  assert.equal(
    (await controlPool.query("SELECT count(*)::integer AS count FROM app.login_send_attempts")).rows[0].count,
    1,
  );
});

test("concurrent global hard limit reserves before delivery and stores no recipient address", async () => {
  const harness = createHarness({
    productOverrides: {
      limits: {
        testDailyEmailHardLimit: 3,
        emailCooldownSeconds: 1,
        emailHourlyLimit: 100,
        ipHourlyLimit: 100,
      },
    },
  });
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) => sendOtp(
      harness,
      `parallel-${index}@example.com`,
      { "x-test-client-ip": `203.0.113.${index + 1}` },
    )),
  );
  assert.equal(responses.filter((response) => response.status === 200).length, 3);
  assert.equal(responses.filter((response) => response.status === 429).length, 9);
  assert.equal(
    (await controlPool.query("SELECT count(*)::integer AS count FROM app.login_mail_deliveries")).rows[0].count,
    3,
  );
  const columns = await controlPool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name IN ('login_send_attempts', 'login_mail_deliveries')
    ORDER BY table_name, column_name
  `);
  assert.doesNotMatch(JSON.stringify(columns.rows), /email_address|recipient_email|otp/i);
});

test("Fake mail reader exists only when explicitly injected into a test app", async () => {
  const hidden = createHarness({ exposeFake: false });
  assert.equal((await sendOtp(hidden, "hidden@example.com")).status, 200);
  assert.equal(
    (await hidden.app.request("https://dailynews.test/__test__/mail/latest?email=hidden%40example.com")).status,
    404,
  );
  const login = await hidden.app.request("https://dailynews.test/login");
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-security-policy"), /default-src 'self'/);
  const css = await hidden.app.request("https://dailynews.test/assets/cloud.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  assert.match(await css.text(), /macrostructure: Split Studio \+ reading projection/);
});

test("cross-origin first sign-in with a valid OTP is rejected without consuming it or creating identity state", async () => {
  const harness = createHarness();
  const email = "login-csrf@example.com";
  assert.equal((await sendOtp(harness, email)).status, 200);
  const otp = await latestOtp(harness, email);

  const rejected = await verifyOtp(harness, email, otp, { origin: "https://attacker.example" });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: { code: "request_failed" } });
  const identityState = await controlPool.query(`
    SELECT
      (SELECT count(*)::integer FROM auth."user") AS users,
      (SELECT count(*)::integer FROM auth."session") AS sessions,
      (SELECT count(*)::integer FROM auth."verification") AS verifications
  `);
  assert.deepEqual(identityState.rows[0], { users: 0, sessions: 0, verifications: 1 });

  const accepted = await verifyOtp(harness, email, otp);
  assert.equal(accepted.status, 200);
  assert.ok(sessionCookie(accepted));
});

test("cross-origin requests and provider failures stop before any successful delivery", async () => {
  const harness = createHarness();
  const crossOrigin = await post(
    harness.app,
    "/api/auth/email-otp/send-verification-otp",
    { email: "origin@example.com", type: "sign-in" },
    { origin: "https://attacker.example" },
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(
    (await controlPool.query("SELECT count(*)::integer AS count FROM app.login_send_attempts")).rows[0].count,
    0,
  );

  harness.fakeMail.failWith(new Error("provider body with recipient@example.com and secret"));
  const failed = await sendOtp(harness, "provider@example.com");
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: { code: "service_unavailable" } });
  const result = await controlPool.query(`
    SELECT
      (SELECT count(*)::integer FROM app.login_send_attempts WHERE status = 'failed') AS failed,
      (SELECT count(*)::integer FROM app.login_mail_deliveries) AS deliveries
  `);
  assert.deepEqual(result.rows[0], { failed: 1, deliveries: 0 });
});
