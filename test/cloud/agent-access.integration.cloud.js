import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, beforeEach } from "node:test";
import pg from "pg";
import { createCloudApp } from "../../.cloud-dist/src/cloud/app.js";
import { runMigrations } from "../../.cloud-dist/src/adapters/postgres/migrations.js";
import { createAuthPostgresPool, createPostgresPool } from "../../.cloud-dist/src/adapters/postgres/pool.js";
import { PostgresTenancyStore } from "../../.cloud-dist/src/adapters/postgres/tenancy.js";
import { PostgresAgentAccessRepository } from "../../.cloud-dist/src/adapters/postgres/agent-credentials.js";
import { FakeMailAdapter } from "../../.cloud-dist/src/adapters/mail/mail.js";
import { createIdentityService } from "../../.cloud-dist/src/modules/identity/auth.js";
import { keyedDigest } from "../../.cloud-dist/src/modules/identity/security.js";
import { AgentCredentialService } from "../../.cloud-dist/src/modules/agent-access/credential-service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
if (!/(?:test|ci)/i.test(databaseName)) {
  throw new Error("PostgreSQL integration tests require a dedicated test or CI database");
}

const { Pool } = pg;
const controlPool = new Pool({ connectionString, max: 30, connectionTimeoutMillis: 5000 });
const openHarnesses = new Set();
const migrationsDirectory = new URL("../../db/migrations", import.meta.url).pathname;

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
    emailCooldownSeconds: 1,
    emailHourlyLimit: 100,
    ipHourlyLimit: 100,
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
  const mergedProduct = {
    ...product,
    ...productOverrides,
    limits: { ...product.limits, ...productOverrides.limits },
    identity: { ...product.identity, ...productOverrides.identity },
    agentAccess: { ...product.agentAccess, ...productOverrides.agentAccess },
  };
  return {
    origin: "https://dailynews.test",
    basePath: "",
    host: "127.0.0.1",
    port: 0,
    database: {
      connectionString,
      sslMode: "disable",
      max: 20,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 5000,
    },
    identity: {
      authSecret: "agent-access-auth-secret-at-least-32-characters",
      digestSecret: "agent-access-identity-digest-at-least-32-characters",
      mailMode: "fake",
    },
    agentAccess: {
      tokenDigestSecret: "agent-access-token-digest-at-least-32-characters",
      pairingCodeDigestSecret: "agent-access-pairing-digest-at-least-32-characters",
      apiBaseUrl: "https://dailynews.test/api/v1",
      mcpUrl: "https://dailynews.test/mcp",
    },
    product: mergedProduct,
  };
}

function createHarness(options = {}) {
  const config = runtimeConfig(options.productOverrides);
  const appPool = createPostgresPool(config.database);
  const authPool = createAuthPostgresPool(config.database);
  const mail = new FakeMailAdapter();
  const identity = createIdentityService({ config, appPool, authPool, mailAdapter: mail });
  const tenancy = new PostgresTenancyStore(appPool);
  const agentAccess = new AgentCredentialService(
    new PostgresAgentAccessRepository(appPool, {
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
      pairingVerifyUrl: "https://dailynews.test/agent-pairing/v1/verify",
    },
  );
  const digestActor = (purpose, value) => keyedDigest(
    config.agentAccess.pairingCodeDigestSecret,
    `${purpose}\0${value}`,
  );
  const app = createCloudApp({
    basePath: "",
    readinessCheck: async () => {},
    identity,
    tenancy,
    defaults: config.product.defaults,
    clientIpResolver: (context) => context.req.header("x-test-client-ip") || "127.0.0.1",
    testMailReader: mail,
    agentSettings: {
      origin: config.origin,
      csrfSecret: config.identity.authSecret,
      service: agentAccess,
      digestActor,
      apiBaseUrl: config.agentAccess.apiBaseUrl,
      mcpUrl: config.agentAccess.mcpUrl,
      activeCredentialLimit: config.product.limits.activeTokensPerUser,
      requestBodyLimitBytes: config.product.agentAccess.requestBodyLimitBytes,
    },
  });
  const harness = {
    app,
    appPool,
    authPool,
    mail,
    agentAccess,
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
    headers: { origin: "https://dailynews.test", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function verifyPairing(app, token, headers = {}) {
  return app.request("https://dailynews.test/agent-pairing/v1/verify", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

async function signIn(harness, email) {
  assert.equal((await post(harness.app, "/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  })).status, 200);
  const otp = harness.mail.latestFor(email)?.otp;
  assert.ok(otp);
  const response = await post(harness.app, "/api/auth/sign-in/email-otp", { email, otp });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";", 1)[0];
}

async function getJson(app, pathname, headers = {}) {
  const response = await app.request(`https://dailynews.test${pathname}`, { headers });
  return { response, body: await response.json() };
}

async function mutate(app, pathname, cookie, csrfToken, body = {}, headers = {}) {
  const response = await post(app, pathname, { ...body, _csrf: csrfToken }, { cookie, ...headers });
  return { response, body: await response.json() };
}

async function waitForBlockedTransactions(blockerPid, minimum) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = await controlPool.query(`
      WITH RECURSIVE blocked(pid) AS (
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND $1::integer = ANY(pg_blocking_pids(pid))
        UNION
        SELECT activity.pid
        FROM pg_stat_activity activity
        JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        WHERE activity.datname = current_database()
      )
      SELECT count(*)::integer AS count FROM blocked
    `, [blockerPid]);
    if (result.rows[0].count >= minimum) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`expected at least ${minimum} transactions blocked by the Space lock holder`);
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

test("bootstrap pairing refreshes, claims once, verifies once, and persists no plaintext secret", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "pairing@example.com");
  assert.equal((await harness.app.request("https://dailynews.test/", { headers: { cookie } })).status, 200);

  const settings = await getJson(harness.app, "/settings/agent", { cookie });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.activeLimit, 10);
  assert.equal(settings.body.authorizations.length, 0);
  assert.equal(settings.body.pairings.length, 1);
  const initial = settings.body.pairings[0];
  assert.match(initial.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);

  const storedBefore = await controlPool.query(
    "SELECT code_digest, intended_name FROM app.agent_pairing_sessions WHERE id = $1",
    [initial.id],
  );
  assert.match(storedBefore.rows[0].code_digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(storedBefore.rows[0]), new RegExp(initial.code.replace("-", ""), "i"));

  const refreshed = await mutate(
    harness.app,
    `/settings/agent/connections/${initial.id}/pair/refresh`,
    cookie,
    settings.body.csrfToken,
  );
  assert.equal(refreshed.response.status, 200);
  assert.notEqual(refreshed.body.pairing.code, initial.code);

  const oldClaim = await post(harness.app, "/agent-pairing/v1/claim", {
    pairingCode: initial.code,
    clientName: "Codex",
  }, { "x-test-client-ip": "203.0.113.10" });
  assert.equal(oldClaim.status, 404);

  const claim = await post(harness.app, "/agent-pairing/v1/claim", {
    pairingCode: refreshed.body.pairing.code,
    clientName: "Codex <script>alert(1)</script>",
  }, { "x-test-client-ip": "203.0.113.10" });
  assert.equal(claim.status, 201);
  const claimed = await claim.json();
  assert.match(claimed.token, /^dnpat_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
  assert.equal(claimed.apiBaseUrl, "https://dailynews.test/api/v1");
  assert.equal(claimed.mcpUrl, "https://dailynews.test/mcp");
  assert.equal(claimed.verifyUrl, "https://dailynews.test/agent-pairing/v1/verify");
  await assert.rejects(
    () => harness.agentAccess.authenticateActiveToken(`Bearer ${claimed.token}`),
    (error) => error.status === 401,
  );

  const duplicateClaim = await post(harness.app, "/agent-pairing/v1/claim", {
    pairingCode: refreshed.body.pairing.code,
    clientName: "Codex",
  }, { "x-test-client-ip": "203.0.113.10" });
  assert.equal(duplicateClaim.status, 404);

  const stored = await controlPool.query(`
    SELECT selector, secret_digest, token_hint, name, status
    FROM app.agent_credentials
    WHERE id = $1
  `, [claimed.credentialId]);
  assert.equal(stored.rows[0].status, "provisioning");
  assert.doesNotMatch(JSON.stringify(stored.rows[0]), new RegExp(claimed.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const wrongToken = `${claimed.token.slice(0, -1)}${claimed.token.endsWith("A") ? "B" : "A"}`;
  const wrongVerify = await verifyPairing(harness.app, wrongToken, {
    "x-test-client-ip": "203.0.113.10",
  });
  assert.equal(wrongVerify.status, 401);
  assert.equal(wrongVerify.headers.get("www-authenticate"), "Bearer");

  const verify = await verifyPairing(harness.app, claimed.token, {
    "x-test-client-ip": "203.0.113.10",
  });
  assert.equal(verify.status, 200);
  const verified = await verify.json();
  assert.equal(verified.status, "active");
  assert.deepEqual(verified.context, {
    publicationId: "daily-news",
    publicationName: "DailyNews",
    timeZone: "Asia/Shanghai",
    todoEnabled: false,
  });
  assert.equal(
    (await harness.agentAccess.authenticateActiveToken(`Bearer ${claimed.token}`)).id,
    claimed.credentialId,
  );
  assert.equal((await verifyPairing(harness.app, claimed.token, {
    "x-test-client-ip": "203.0.113.10",
  })).status, 401);

  const after = await getJson(harness.app, "/settings/agent", { cookie });
  assert.equal(after.body.authorizations.length, 1);
  assert.equal(after.body.authorizations[0].name, "Codex <script>alert(1)</script>");
  assert.doesNotMatch(JSON.stringify(after.body), /tokenHint|secretDigest|selector|dnpat_/);
  assert.equal((await harness.app.request("https://dailynews.test/", {
    headers: { authorization: `Bearer ${claimed.token}` },
  })).status, 303);

  const audits = await controlPool.query("SELECT event_type FROM app.audit_events ORDER BY created_at");
  assert.ok(audits.rows.some(({ event_type }) => event_type === "pairing_claimed"));
  assert.ok(audits.rows.some(({ event_type }) => event_type === "pairing_verify_failed"));
  assert.ok(audits.rows.some(({ event_type }) => event_type === "pairing_verified"));
});

test("manual token operations are CSRF-safe, one-time, tenant-bound, and independently revocable", async () => {
  const harness = createHarness();
  const cookieA = await signIn(harness, "manual-a@example.com");
  const settingsA = await getJson(harness.app, "/settings/agent/manual-tokens", { cookie: cookieA });
  assert.equal(settingsA.response.status, 200);

  const crossOrigin = await mutate(
    harness.app,
    "/settings/agent/manual-tokens",
    cookieA,
    settingsA.body.csrfToken,
    { name: "跨站请求", operationId: randomUUID() },
    { origin: "https://attacker.example" },
  );
  assert.equal(crossOrigin.response.status, 403);

  const operationId = randomUUID();
  const created = await mutate(
    harness.app,
    "/settings/agent/manual-tokens",
    cookieA,
    settingsA.body.csrfToken,
    { name: "自动化脚本", operationId },
  );
  assert.equal(created.response.status, 201);
  assert.match(created.body.token, /^dnpat_/);
  const repeated = await mutate(
    harness.app,
    "/settings/agent/manual-tokens",
    cookieA,
    settingsA.body.csrfToken,
    { name: "自动化脚本", operationId },
  );
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.repeated, true);
  assert.equal(repeated.body.token, null);
  const conflict = await mutate(
    harness.app,
    "/settings/agent/manual-tokens",
    cookieA,
    settingsA.body.csrfToken,
    { name: "另一项请求", operationId },
  );
  assert.equal(conflict.response.status, 409);

  const cookieB = await signIn(harness, "manual-b@example.com");
  const settingsB = await getJson(harness.app, "/settings/agent", { cookie: cookieB });
  const crossTenant = await mutate(
    harness.app,
    `/settings/agent/connections/${created.body.credential.id}/remove`,
    cookieB,
    settingsB.body.csrfToken,
  );
  assert.equal(crossTenant.response.status, 404);

  const rotatePage = await getJson(
    harness.app,
    `/settings/agent/manual-tokens/${created.body.credential.id}/rotate`,
    { cookie: cookieA },
  );
  assert.equal(rotatePage.response.status, 200);
  const rotated = await mutate(
    harness.app,
    `/settings/agent/manual-tokens/${created.body.credential.id}/rotate`,
    cookieA,
    rotatePage.body.csrfToken,
    { name: "自动化脚本（新）", operationId: rotatePage.body.operationId },
  );
  assert.equal(rotated.response.status, 201);
  assert.match(rotated.body.token, /^dnpat_/);
  const repeatedRotation = await mutate(
    harness.app,
    `/settings/agent/manual-tokens/${created.body.credential.id}/rotate`,
    cookieA,
    rotatePage.body.csrfToken,
    { name: "自动化脚本（新）", operationId: rotatePage.body.operationId },
  );
  assert.equal(repeatedRotation.response.status, 200);
  assert.equal(repeatedRotation.body.token, null);
  await assert.rejects(
    () => harness.agentAccess.authenticateActiveToken(`Bearer ${created.body.token}`),
    (error) => error.status === 401,
  );
  assert.equal(
    (await harness.agentAccess.authenticateActiveToken(`Bearer ${rotated.body.token}`)).id,
    rotated.body.credential.id,
  );

  const statuses = await controlPool.query(
    "SELECT id, status FROM app.agent_credentials WHERE id = ANY($1::uuid[]) ORDER BY created_at",
    [[created.body.credential.id, rotated.body.credential.id]],
  );
  assert.deepEqual(statuses.rows.map(({ status }) => status), ["rotated", "active"]);
  const revoked = await mutate(
    harness.app,
    `/settings/agent/manual-tokens/${rotated.body.credential.id}/revoke`,
    cookieA,
    rotatePage.body.csrfToken,
  );
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.credential.status, "revoked");
  await assert.rejects(
    () => harness.agentAccess.authenticateActiveToken(`Bearer ${rotated.body.token}`),
    (error) => error.status === 401,
  );
});

test("credential quota serializes concurrent creation and pairing refresh consumes no new slot", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "quota@example.com");
  const settings = await getJson(harness.app, "/settings/agent", { cookie });
  const pairing = settings.body.pairings[0];
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => mutate(
    harness.app,
    "/settings/agent/manual-tokens",
    cookie,
    settings.body.csrfToken,
    { name: `Agent ${index + 1}`, operationId: randomUUID() },
  )));
  assert.equal(attempts.filter(({ response }) => response.status === 201).length, 9);
  assert.equal(attempts.filter(({ response }) => response.status === 409).length, 3);
  const occupied = await controlPool.query(`
    SELECT
      (SELECT count(*)::integer FROM app.agent_credentials WHERE status IN ('active', 'provisioning')) AS credentials,
      (SELECT count(*)::integer FROM app.agent_pairing_sessions WHERE status = 'pending') AS pairings
  `);
  assert.deepEqual(occupied.rows[0], { credentials: 9, pairings: 1 });

  const refreshed = await mutate(
    harness.app,
    `/settings/agent/connections/${pairing.id}/pair/refresh`,
    cookie,
    settings.body.csrfToken,
  );
  assert.equal(refreshed.response.status, 200);
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.agent_pairing_sessions")).rows[0].count, 1);
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.agent_credentials")).rows[0].count, 9);
});

test("claim and browser bootstrap acquire the Space lock before the pairing row", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "claim-lock-order@example.com");
  assert.equal((await harness.app.request("https://dailynews.test/", { headers: { cookie } })).status, 200);
  const settings = await getJson(harness.app, "/settings/agent", { cookie });
  const pairing = settings.body.pairings[0];
  const stored = await controlPool.query(
    "SELECT space_id FROM app.agent_pairing_sessions WHERE id = $1",
    [pairing.id],
  );
  const blocker = await controlPool.connect();
  let claimPromise;
  let homePromise;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM app.spaces WHERE id = $1 FOR UPDATE", [stored.rows[0].space_id]);
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    claimPromise = post(harness.app, "/agent-pairing/v1/claim", {
      pairingCode: pairing.code,
      clientName: "Concurrent claimant",
    });
    homePromise = harness.app.request("https://dailynews.test/", { headers: { cookie } });
    await waitForBlockedTransactions(blockerPid, 2);

    const observer = await controlPool.connect();
    try {
      await observer.query("BEGIN");
      await observer.query(
        "SELECT id FROM app.agent_pairing_sessions WHERE id = $1 FOR UPDATE NOWAIT",
        [pairing.id],
      );
      await observer.query("ROLLBACK");
    } finally {
      observer.release();
    }
    await blocker.query("COMMIT");
    assert.equal((await claimPromise).status, 201);
    assert.equal((await homePromise).status, 200);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
    await Promise.allSettled([claimPromise, homePromise].filter(Boolean));
  }
});

test("verify and cancellation serialize at Space before locking pairing or credential rows", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "verify-lock-order@example.com");
  assert.equal((await harness.app.request("https://dailynews.test/", { headers: { cookie } })).status, 200);
  const settings = await getJson(harness.app, "/settings/agent", { cookie });
  const pairing = settings.body.pairings[0];
  const claim = await post(harness.app, "/agent-pairing/v1/claim", {
    pairingCode: pairing.code,
    clientName: "Concurrent verifier",
  });
  assert.equal(claim.status, 201);
  const claimed = await claim.json();
  const stored = await controlPool.query(
    "SELECT space_id FROM app.agent_pairing_sessions WHERE id = $1",
    [pairing.id],
  );
  const blocker = await controlPool.connect();
  let verifyPromise;
  let cancelPromise;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM app.spaces WHERE id = $1 FOR UPDATE", [stored.rows[0].space_id]);
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    verifyPromise = verifyPairing(harness.app, claimed.token);
    cancelPromise = mutate(
      harness.app,
      `/settings/agent/connections/${pairing.id}/pair/cancel`,
      cookie,
      settings.body.csrfToken,
    );
    await waitForBlockedTransactions(blockerPid, 2);

    const observer = await controlPool.connect();
    try {
      await observer.query("BEGIN");
      await observer.query(
        "SELECT id FROM app.agent_pairing_sessions WHERE id = $1 FOR UPDATE NOWAIT",
        [pairing.id],
      );
      await observer.query(
        "SELECT id FROM app.agent_credentials WHERE id = $1 FOR UPDATE NOWAIT",
        [claimed.credentialId],
      );
      await observer.query("ROLLBACK");
    } finally {
      observer.release();
    }
    await blocker.query("COMMIT");
    const verifyStatus = (await verifyPromise).status;
    const cancelStatus = (await cancelPromise).response.status;
    assert.ok(
      (verifyStatus === 200 && cancelStatus === 409)
      || (verifyStatus === 401 && cancelStatus === 200),
    );
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
    await Promise.allSettled([verifyPromise, cancelPromise].filter(Boolean));
  }
});

test("pairing rate limits persist and expired provisioning credentials are revoked before retry", async () => {
  const limited = createHarness({ productOverrides: { agentAccess: { claimIpHourlyLimit: 2 } } });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await post(limited.app, "/agent-pairing/v1/claim", {
      pairingCode: "23456-789AB",
      clientName: "Rate probe",
    }, { "x-test-client-ip": "198.51.100.50" });
    assert.equal(response.status, attempt < 2 ? 404 : 429);
  }
  assert.equal((await controlPool.query(
    "SELECT count(*)::integer AS count FROM app.agent_rate_limit_events WHERE action = 'pairing_claim'",
  )).rows[0].count, 2);
  await limited.close();

  await resetAndMigrate();
  const harness = createHarness();
  const cookie = await signIn(harness, "expired@example.com");
  const settings = await getJson(harness.app, "/settings/agent", { cookie });
  const pairing = settings.body.pairings[0];
  const claim = await post(harness.app, "/agent-pairing/v1/claim", {
    pairingCode: pairing.code,
    clientName: "Expired client",
  });
  assert.equal(claim.status, 201);
  const claimed = await claim.json();
  await controlPool.query(
    "UPDATE app.agent_credentials SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [claimed.credentialId],
  );
  const expired = await verifyPairing(harness.app, claimed.token);
  assert.equal(expired.status, 401);
  const lifecycle = await controlPool.query(`
    SELECT c.status AS credential_status, p.status AS pairing_status
    FROM app.agent_credentials c
    JOIN app.agent_pairing_sessions p ON p.provisioning_credential_id = c.id
    WHERE c.id = $1
  `, [claimed.credentialId]);
  assert.deepEqual(lifecycle.rows[0], { credential_status: "revoked", pairing_status: "expired" });

  const retry = await getJson(harness.app, `/settings/agent/connections/${pairing.id}/pair`, { cookie });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.pairing.status, "pending");
  assert.notEqual(retry.body.pairing.code, pairing.code);
  assert.equal((await verifyPairing(harness.app, claimed.token)).status, 401);
});
