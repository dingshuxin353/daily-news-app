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
import { PrivateReadingService } from "../../.cloud-dist/src/modules/private-reading/service.js";
import { UserProfileService } from "../../.cloud-dist/src/modules/identity/profile-service.js";
import { SiteManagementService } from "../../.cloud-dist/src/modules/site-management/service.js";
import { SiteThemeCatalogService } from "../../.cloud-dist/src/modules/site-management/theme-catalog.js";
import { PostgresSiteManagementRepository } from "../../.cloud-dist/src/adapters/postgres/site-management.js";
import { createFileThemeStorage } from "../../scripts/lib/storage/file-theme.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
if (!/(?:test|ci)/i.test(databaseName)) throw new Error("PostgreSQL integration tests require a dedicated test or CI database");

const { Pool } = pg;
const controlPool = new Pool({ connectionString, max: 30, connectionTimeoutMillis: 5000 });
const openHarnesses = new Set();
const migrationsDirectory = new URL("../../db/migrations", import.meta.url).pathname;
const projectRoot = new URL("../../", import.meta.url).pathname;
const systemThemes = createFileThemeStorage({ rootDir: projectRoot });
const requestEnvironment = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 443, remoteFamily: "IPv4", encrypted: true } } };

const defaults = {
  spaceName: "我的日报",
  timeZone: "Asia/Shanghai",
  publicationId: "daily-news",
  publicationName: "DailyNews",
  theme: { id: "newspaper-default", revision: 1 },
  todoEnabled: false,
  priorityLimits: { lead: 1, important: 2, normal: null },
};

function appRequest(app, pathname, init = {}) {
  return app.request(`https://dailynews.test${pathname}`, {
    ...init,
    headers: { host: "dailynews.test", ...Object.fromEntries(new Headers(init.headers)) },
  }, requestEnvironment);
}

async function post(app, pathname, body, headers = {}) {
  return appRequest(app, pathname, {
    method: "POST",
    headers: { origin: "https://dailynews.test", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function resetAndMigrate() {
  await controlPool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await controlPool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await runMigrations(controlPool, { migrationsDirectory });
}

function createHarness(activeLimit = 10) {
  const database = { connectionString, sslMode: "disable", max: 20, idleTimeoutMillis: 1000, connectionTimeoutMillis: 5000 };
  const runtime = {
    origin: "https://dailynews.test",
    basePath: "",
    host: "127.0.0.1",
    port: 0,
    database,
    identity: {
      authSecret: "agent-access-auth-secret-at-least-32-characters",
      digestSecret: "agent-access-identity-secret-at-least-32-characters",
      mailMode: "fake",
    },
    agentAccess: {
      tokenDigestSecret: "agent-access-token-secret-at-least-32-characters",
      apiBaseUrl: "https://dailynews.test/api/v1",
      mcpUrl: "https://dailynews.test/mcp",
    },
    product: {
      schemaVersion: 1,
      defaults,
      limits: {
        publicationsPerSpace: 8,
        customThemesPerSpace: 24,
        activeTokensPerUser: activeLimit,
        testDailyEmailHardLimit: 100,
        emailCooldownSeconds: 1,
        emailHourlyLimit: 100,
        ipHourlyLimit: 100,
      },
      identity: { otpLength: 6, otpExpiresInSeconds: 300, otpAllowedAttempts: 3, sessionExpiresInDays: 30 },
      agentAccess: { requestBodyLimitBytes: 16384, rateLimitRetentionHours: 24, auditRetentionDays: 90 },
    },
  };
  const appPool = createPostgresPool(database);
  const authPool = createAuthPostgresPool(database);
  const mail = new FakeMailAdapter();
  const identity = createIdentityService({ config: runtime, appPool, authPool, mailAdapter: mail });
  const tenancy = new PostgresTenancyStore(appPool);
  const profiles = new UserProfileService(appPool);
  const privateReading = new PrivateReadingService(appPool, tenancy, systemThemes, () => new Date("2026-08-27T08:00:00+08:00"), profiles);
  const credentials = new AgentCredentialService(
    new PostgresAgentAccessRepository(appPool, { auditDays: 90 }),
    { tokenDigestSecret: runtime.agentAccess.tokenDigestSecret, activeCredentialLimit: activeLimit },
  );
  const siteManagement = new SiteManagementService(
    new PostgresSiteManagementRepository(appPool, systemThemes),
    defaults,
    8,
  );
  const digestActor = (purpose, value) => keyedDigest(runtime.agentAccess.tokenDigestSecret, `${purpose}\0${value}`);
  const app = createCloudApp({
    basePath: "",
    readinessCheck: async () => {},
    identity,
    tenancy,
    privateReading,
    defaults,
    clientIpResolver: (context) => context.req.header("x-test-client-ip") || "127.0.0.1",
    testMailReader: mail,
    agentSettings: {
      origin: runtime.origin,
      csrfSecret: runtime.identity.authSecret,
      service: credentials,
      digestActor,
      apiBaseUrl: runtime.agentAccess.apiBaseUrl,
      mcpUrl: runtime.agentAccess.mcpUrl,
      activeCredentialLimit: activeLimit,
      requestBodyLimitBytes: 16384,
    },
    siteSettings: {
      origin: runtime.origin,
      csrfSecret: runtime.identity.authSecret,
      service: siteManagement,
      themes: new SiteThemeCatalogService(appPool, systemThemes),
      profiles,
      publicationLimit: 8,
      requestBodyLimitBytes: 16384,
    },
  });
  const harness = {
    app, appPool, authPool, mail, credentials, profiles, tenancy,
    async close() {
      openHarnesses.delete(harness);
      await Promise.all([appPool.end(), authPool.end()]);
    },
  };
  openHarnesses.add(harness);
  return harness;
}

async function signIn(harness, email, completeProfile = true) {
  assert.equal((await post(harness.app, "/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" })).status, 200);
  const otp = harness.mail.latestFor(email)?.otp;
  assert.ok(otp);
  const response = await post(harness.app, "/api/auth/sign-in/email-otp", { email, otp });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  if (completeProfile) {
    const user = await controlPool.query('SELECT "id" FROM auth."user" WHERE "email" = $1', [email]);
    await harness.profiles.setNickname(user.rows[0].id, "测试用户");
  }
  return cookie;
}

async function getSettings(harness, pathname, cookie, accept = "application/json") {
  const response = await appRequest(harness.app, pathname, { headers: { cookie, accept } });
  return { response, body: accept.includes("json") && response.status !== 404 ? await response.json() : null };
}

async function mutate(harness, pathname, cookie, csrfToken, body = {}, headers = {}) {
  const response = await post(harness.app, pathname, { ...body, _csrf: csrfToken }, { cookie, ...headers });
  return { response, body: await response.json() };
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

test("final Agent access schema contains only digest-backed Token lifecycle facts", async () => {
  const tables = (await controlPool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename")).rows.map(({ tablename }) => tablename);
  assert.ok(tables.includes("agent_credentials"));
  assert.equal(tables.some((name) => name.includes("pairing")), false);
  const columns = (await controlPool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'agent_credentials' ORDER BY ordinal_position")).rows.map(({ column_name }) => column_name);
  assert.equal(columns.includes("expires_at"), false);
  const constraints = (await controlPool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'app.agent_credentials'::regclass")).rows.map(({ definition }) => definition).join("\n");
  assert.doesNotMatch(constraints, /provisioning|pairing/i);
});

test("new users reach onboarding without implicit Token creation and see only the direct Token journey", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "onboarding@example.test");
  assert.equal((await appRequest(harness.app, "/post-login", { headers: { cookie } })).headers.get("location"), "/onboarding");
  const page = await getSettings(harness, "/onboarding", cookie, "text/html");
  assert.equal(page.response.status, 200);
  const html = await page.response.text();
  assert.match(html, /请先完整阅读 https:\/\/dailynews\.test\/agent-setup\.md/);
  assert.match(html, /等 Agent 向你索取 Token/);
  assert.match(html, /value="我的 Agent"/);
  assert.doesNotMatch(html, /配对|倒计时|刷新|取消|认领|等待 Agent/);
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.agent_credentials")).rows[0].count, 0);
});

test("new Publication form proposes a random available address once and preserves submitted input after validation", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "new-publication@example.test");
  const page = await getSettings(harness, "/settings/sites/new", cookie, "text/html");
  assert.equal(page.response.status, 200);
  const html = await page.response.text();
  const csrfToken = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  const generatedId = html.match(/name="publicationId" value="(daily-[a-f0-9]{6})"/)?.[1];
  assert.ok(csrfToken);
  assert.ok(generatedId);
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.publications WHERE publication_id = $1", [generatedId])).rows[0].count, 0);

  const submittedId = "keep-this-address";
  const rejected = await post(harness.app, "/settings/sites/new", {
    _csrf: csrfToken,
    name: "",
    publicationId: submittedId,
    themeMode: "inherit",
  }, { cookie });
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), new RegExp(`name="publicationId" value="${submittedId}"`));
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.publications WHERE publication_id = $1", [submittedId])).rows[0].count, 0);
});

test("explicit browser submission creates one active Token, returns plaintext once, and stores only its digest", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "create-token@example.test");
  const settings = await getSettings(harness, "/settings/agent", cookie);
  const operationId = settings.body.operationId;
  const created = await mutate(harness, "/settings/agent/tokens", cookie, settings.body.csrfToken, { name: "  我的 Agent  ", operationId });
  assert.equal(created.response.status, 201);
  assert.match(created.body.token, /^dnpat_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.body.credential.status, "active");
  assert.equal(created.body.credential.name, "我的 Agent");
  const stored = (await controlPool.query("SELECT name, status, selector, secret_digest, token_hint FROM app.agent_credentials")).rows[0];
  assert.equal(stored.name, "我的 Agent");
  assert.equal(stored.status, "active");
  assert.match(stored.secret_digest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(stored).includes(created.body.token), false);

  const repeated = await mutate(harness, "/settings/agent/tokens", cookie, settings.body.csrfToken, { name: "我的 Agent", operationId });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.token, null);
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.agent_credentials")).rows[0].count, 1);
});

test("Token names enforce 1–80 visible characters without disturbing existing credentials", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "token-name@example.test");
  const settings = await getSettings(harness, "/settings/agent", cookie);
  const valid = await mutate(harness, "/settings/agent/tokens", cookie, settings.body.csrfToken, { name: "A".repeat(80), operationId: settings.body.operationId });
  assert.equal(valid.response.status, 201);
  for (const name of [" ", "A".repeat(81), "broken\nname"]) {
    const rejected = await mutate(harness, "/settings/agent/tokens", cookie, settings.body.csrfToken, { name, operationId: randomUUID() });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error.code, "invalid_request");
  }
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.agent_credentials WHERE status = 'active'")).rows[0].count, 1);
});

test("the eleventh active Token is rejected under concurrent creation and successful Tokens remain usable", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "token-limit@example.test");
  const settings = await getSettings(harness, "/settings/agent", cookie);
  const attempts = await Promise.all(Array.from({ length: 11 }, (_, index) => mutate(
    harness,
    "/settings/agent/tokens",
    cookie,
    settings.body.csrfToken,
    { name: `Agent ${index + 1}`, operationId: randomUUID() },
  )));
  assert.equal(attempts.filter(({ response }) => response.status === 201).length, 10);
  assert.equal(attempts.filter(({ body }) => body.error?.code === "credential_limit_reached").length, 1);
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.agent_credentials WHERE status = 'active'")).rows[0].count, 10);
});

test("rotation and revocation cut over one Token atomically while preserving other active Tokens", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "token-lifecycle@example.test");
  const settings = await getSettings(harness, "/settings/agent", cookie);
  const first = await mutate(harness, "/settings/agent/tokens", cookie, settings.body.csrfToken, { name: "First Agent", operationId: randomUUID() });
  const second = await mutate(harness, "/settings/agent/tokens", cookie, settings.body.csrfToken, { name: "Second Agent", operationId: randomUUID() });
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);

  const rotatePage = await getSettings(harness, `/settings/agent/tokens/${first.body.credential.id}/rotate`, cookie);
  const rotated = await mutate(harness, `/settings/agent/tokens/${first.body.credential.id}/rotate`, cookie, rotatePage.body.csrfToken, {
    name: first.body.credential.name,
    operationId: rotatePage.body.operationId,
  });
  assert.equal(rotated.response.status, 201);
  await assert.rejects(() => harness.credentials.authenticateActiveToken(`Bearer ${first.body.token}`), (error) => error.status === 401);
  assert.equal((await harness.credentials.authenticateActiveToken(`Bearer ${rotated.body.token}`)).id, rotated.body.credential.id);
  assert.equal((await harness.credentials.authenticateActiveToken(`Bearer ${second.body.token}`)).id, second.body.credential.id);

  const revokePage = await getSettings(harness, `/settings/agent/tokens/${rotated.body.credential.id}/revoke`, cookie);
  const revoked = await mutate(harness, `/settings/agent/tokens/${rotated.body.credential.id}/revoke`, cookie, revokePage.body.csrfToken);
  assert.equal(revoked.response.status, 200);
  await assert.rejects(() => harness.credentials.authenticateActiveToken(`Bearer ${rotated.body.token}`), (error) => error.status === 401);
  assert.equal((await harness.credentials.authenticateActiveToken(`Bearer ${second.body.token}`)).id, second.body.credential.id);
});

test("Agent authorization is the only Token management page and all retired routes return 404", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "retired-routes@example.test");
  const agent = await getSettings(harness, "/settings/agent", cookie, "text/html");
  const agentHtml = await agent.response.text();
  assert.match(agentHtml, /创建 Agent Token/);
  assert.match(agentHtml, /轮换|撤销|Token 记录/);

  const advanced = await getSettings(harness, "/settings/advanced", cookie, "text/html");
  const advancedHtml = await advanced.response.text();
  assert.match(advancedHtml, /JSON API/);
  assert.match(advancedHtml, /MCP/);
  assert.match(advancedHtml, /OpenAPI/);
  assert.match(advancedHtml, /前往 Agent 授权/);
  assert.doesNotMatch(advancedHtml, /<form[\s\S]*创建.*Token/);

  for (const pathname of [
    "/publications/",
    "/.well-known/dailynews-agent-setup.json",
    "/agent-pairing/v1/claim",
    "/agent-pairing/v1/verify",
    "/settings/agent/connections",
    "/settings/agent/connections/00000000-0000-4000-8000-000000000001/pair",
    "/settings/advanced/tokens",
  ]) {
    assert.equal((await appRequest(harness.app, pathname, { headers: { cookie } })).status, 404, pathname);
    assert.equal((await post(harness.app, pathname, {}, { cookie })).status, 404, `POST ${pathname}`);
  }
});

test("Token management keeps Session, Origin, CSRF, tenant, and Agent Token boundaries separate", async () => {
  const harness = createHarness();
  const cookieA = await signIn(harness, "space-a@example.test");
  const cookieB = await signIn(harness, "space-b@example.test");
  const settingsA = await getSettings(harness, "/settings/agent", cookieA);
  const settingsB = await getSettings(harness, "/settings/agent", cookieB);
  const created = await mutate(harness, "/settings/agent/tokens", cookieA, settingsA.body.csrfToken, { name: "Space A Agent", operationId: randomUUID() });
  assert.equal(created.response.status, 201);

  assert.equal((await mutate(harness, "/settings/agent/tokens", cookieA, "invalid", { name: "Blocked", operationId: randomUUID() })).response.status, 403);
  assert.equal((await mutate(harness, "/settings/agent/tokens", cookieA, settingsA.body.csrfToken, { name: "Blocked", operationId: randomUUID() }, { origin: "https://attacker.test" })).response.status, 403);
  assert.equal((await post(harness.app, "/settings/agent/tokens", { name: "Blocked", operationId: randomUUID(), _csrf: settingsA.body.csrfToken }, { authorization: `Bearer ${created.body.token}` })).status, 401);
  assert.equal((await mutate(harness, `/settings/agent/tokens/${created.body.credential.id}/revoke`, cookieB, settingsB.body.csrfToken)).response.status, 404);
  assert.equal((await harness.credentials.authenticateActiveToken(`Bearer ${created.body.token}`)).id, created.body.credential.id);
});
