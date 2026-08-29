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
import { compileIssue } from "../../scripts/lib/compiler.js";
import { createFileThemeStorage } from "../../scripts/lib/storage/file-theme.js";

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
const projectRoot = new URL("../../", import.meta.url).pathname;
const systemThemes = createFileThemeStorage({ rootDir: projectRoot });
const testRequestEnvironment = {
  incoming: {
    socket: {
      remoteAddress: "127.0.0.1",
      remotePort: 443,
      remoteFamily: "IPv4",
      encrypted: true,
    },
  },
};

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
  const privateReading = new PrivateReadingService(appPool, tenancy, systemThemes, () => new Date("2026-08-27T08:00:00+08:00"));
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
    privateReading,
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
    tenancy,
    privateReading,
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

function appRequest(app, input, init = {}) {
  return app.request(input, {
    ...init,
    headers: {
      host: "dailynews.test",
      ...Object.fromEntries(new Headers(init.headers)),
    },
  }, testRequestEnvironment);
}

async function post(app, pathname, body, headers = {}) {
  return appRequest(app, `https://dailynews.test${pathname}`, {
    method: "POST",
    headers: { origin: "https://dailynews.test", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function verifyPairing(app, token, headers = {}) {
  return appRequest(app, "https://dailynews.test/agent-pairing/v1/verify", {
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
  const response = await appRequest(app, `https://dailynews.test${pathname}`, { headers });
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

test("private product journey keeps onboarding, sample replacement, formal Daily, and Todo projection on one tenant", async () => {
  const harness = createHarness();
  const cookie = await signIn(harness, "reader@example.com");

  const publicPage = await appRequest(harness.app, "https://dailynews.test/", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /每天一份，只为你而编的私人日报/);

  const destination = await appRequest(harness.app, "https://dailynews.test/post-login", {
    headers: { cookie },
  });
  assert.equal(destination.status, 303);
  assert.equal(destination.headers.get("location"), "/onboarding");

  const anchoredLogin = await appRequest(harness.app, "https://dailynews.test/login?returnTo=%2Ftodo%2F%23todo-1234abcd", {
    headers: { accept: "text/html" },
  });
  assert.equal(anchoredLogin.status, 200);
  assert.match(await anchoredLogin.text(), /data-return-to="\/todo\/#todo-1234abcd"/);
  const anchoredDestination = await appRequest(harness.app, "https://dailynews.test/post-login?returnTo=%2Ftodo%2F%23todo-1234abcd", {
    headers: { cookie },
  });
  assert.equal(anchoredDestination.headers.get("location"), "/todo/#todo-1234abcd");

  const onboarding = await appRequest(harness.app, "https://dailynews.test/onboarding", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(onboarding.status, 200);
  const onboardingHtml = await onboarding.text();
  assert.match(onboardingHtml, /把这段话发给你的 Agent/);
  assert.match(onboardingHtml, /当前显示的配对码/);
  assert.match(onboardingHtml, /data-copy-source="pairing"/);
  const instructionText = /data-copy-source="instruction">([\s\S]*?)<\/pre>/.exec(onboardingHtml)?.[1] ?? "";
  assert.doesNotMatch(instructionText, /[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}/);

  const setupResponse = await appRequest(
    harness.app,
    "https://dailynews.test/.well-known/dailynews-agent-setup.json",
  );
  assert.equal(setupResponse.status, 200);
  const setup = await setupResponse.json();
  assert.equal(setup.instructionsVersion, "1.0.0");
  assert.deepEqual(setup.mcp, {
    url: "https://dailynews.test/mcp",
    transport: "streamable-http",
    protocolVersions: ["2026-07-28", "2025-11-25"],
    authorization: "bearer",
  });
  assert.match(setup.instructions.join(" "), /定时任务/);
  assert.doesNotMatch(JSON.stringify(setup), /dnpat_|配对码：/);

  const sampleHome = await appRequest(harness.app, "https://dailynews.test/home", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(sampleHome.status, 200);
  const sampleHtml = await sampleHome.text();
  assert.match(sampleHtml, /示例日报/);
  assert.match(sampleHtml, /\/assets\/themes\/newspaper-default\/1\.css/);
  assert.doesNotMatch(sampleHtml, /下次更新时间|负责 Agent|调度健康|迟到/);
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.issues")).rows[0].count, 0);
  assert.equal((await controlPool.query("SELECT count(*)::integer AS count FROM app.daily_candidates")).rows[0].count, 0);
  const themeAsset = await appRequest(harness.app, "https://dailynews.test/assets/themes/newspaper-default/1.css");
  assert.equal(themeAsset.status, 200);
  assert.match(await themeAsset.text(), /--color-paper: var\(--color-background\)/);

  const space = (await controlPool.query("SELECT id FROM app.spaces")).rows[0];
  const issue = {
    schemaVersion: 1,
    date: "2026-08-27",
    generatedAt: "2026-08-27T08:00:00+08:00",
    coverage: { start: "2026-08-26T08:00:00+08:00", end: "2026-08-27T08:00:00+08:00" },
    revision: 1,
    items: [
      { id: "formal-lead", title: "正式主标题", brief: "正式短摘要", summary: "正式完整摘要，用于验证第一份个性化日报会在 Home 的同一位置替换系统示例，而不会与示例并排展示。这里保留足够正文，让大模块使用正式 summary。", category: "正式内容", editorial: { priority: "lead", selectionReason: "正式首要内容" }, sources: [{ name: "正式来源一", url: "https://example.com/lead" }] },
      { id: "formal-normal", title: "正式次标题", brief: "正式次要摘要", summary: "正式次要完整摘要，用于验证编译顺序和层级。", category: "正式内容", editorial: { priority: "normal", selectionReason: "正式次要内容" }, sources: [{ name: "正式来源二", url: "https://example.com/normal" }] },
    ],
  };
  const compiled = compileIssue(issue).compiled;
  await controlPool.query(
    `INSERT INTO app.issues (space_id, publication_id, issue_date, revision, issue_payload)
     VALUES ($1, 'daily-news', $2::date, 1, $3::jsonb)`,
    [space.id, issue.date, JSON.stringify(issue)],
  );
  await controlPool.query(
    `INSERT INTO app.compiled_editions (space_id, publication_id, issue_date, revision, compiled_payload)
     VALUES ($1, 'daily-news', $2::date, 1, $3::jsonb)`,
    [space.id, issue.date, JSON.stringify(compiled)],
  );

  const tenant = await harness.tenancy.resolveTenantContextForSpace(space.id);
  const formalReading = await harness.privateReading.readLatestDaily(tenant);
  assert.equal(formalReading.date, issue.date);
  assert.equal(formalReading.projection.rows[0].modules[0].item.id, "formal-lead");

  const formalHome = await appRequest(harness.app, "https://dailynews.test/home", { headers: { cookie, accept: "text/html" } });
  assert.equal(formalHome.status, 200);
  const formalHomeHtml = await formalHome.text();
  assert.match(formalHomeHtml, /个性化正式日报/);
  assert.match(formalHomeHtml, /正式主标题/);
  assert.doesNotMatch(formalHomeHtml, /把一天的信息/);

  const dailyPage = await appRequest(harness.app, "https://dailynews.test/p/daily-news/?date=2026-08-27", { headers: { cookie, accept: "text/html" } });
  assert.equal(dailyPage.status, 200);
  const dailyHtml = await dailyPage.text();
  assert.ok(dailyHtml.indexOf("正式主标题") < dailyHtml.indexOf("正式次标题"));
  assert.match(dailyHtml, /daily-module--large/);
  assert.match(dailyHtml, /daily-module--small/);
  const missing = await appRequest(harness.app, "https://dailynews.test/p/daily-news/?date=2026-08-26", { headers: { cookie, accept: "text/html" } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /没有找到这期正式日报/);

  const otherTenant = await harness.tenancy.ensureSpaceForUser("private-reading-other-user", product.defaults);
  await controlPool.query(
    `INSERT INTO app.publications (space_id, publication_id, display_name, status, sort_order)
     VALUES ($1, 'private-other', '其他用户的私密日报', 'active', 1)`,
    [otherTenant.spaceId],
  );
  const crossTenant = await appRequest(harness.app, "https://dailynews.test/p/private-other/?date=2026-08-27", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(crossTenant.status, 404);
  assert.doesNotMatch(await crossTenant.text(), /其他用户的私密日报|正式主标题/);
  const nonexistent = await appRequest(harness.app, "https://dailynews.test/p/not-a-publication/?date=2026-08-27", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(nonexistent.status, 404);
  assert.doesNotMatch(await nonexistent.text(), /正式主标题/);

  const agentSettings = await getJson(harness.app, "/settings/agent", { cookie });
  const disabledSettings = await appRequest(harness.app, "https://dailynews.test/settings/todo?reason=todo-disabled", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(disabledSettings.status, 200);
  const disabledSettingsHtml = await disabledSettings.text();
  assert.match(disabledSettingsHtml, /个人待办尚未启用/);
  assert.doesNotMatch(disabledSettingsHtml, /今天的正式任务/);
  const enabled = await appRequest(harness.app, "https://dailynews.test/settings/todo/enable", {
    method: "POST",
    headers: { cookie, origin: "https://dailynews.test", accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: agentSettings.body.csrfToken }).toString(),
  });
  assert.equal(enabled.status, 303);
  assert.equal(enabled.headers.get("location"), "/todo/");

  const todoState = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2026-08-27T08:00:00+08:00",
    items: [
      { id: "todo-1234abcd", title: "今天的正式任务", note: "只来自正式 Todo State", dueDate: "2026-08-27", dueTime: "15:00", status: "open", createdAt: "2026-08-27T07:00:00+08:00", updatedAt: "2026-08-27T07:00:00+08:00", completedAt: null, archivedAt: null },
    ],
  };
  await controlPool.query(
    "INSERT INTO app.todo_states (space_id, revision, state_payload) VALUES ($1, 1, $2::jsonb)",
    [space.id, JSON.stringify(todoState)],
  );
  const todoPage = await appRequest(harness.app, "https://dailynews.test/todo/", { headers: { cookie, accept: "text/html" } });
  assert.equal(todoPage.status, 200);
  const todoHtml = await todoPage.text();
  for (const heading of ["已逾期", "今天", "接下来", "暂无日期", "今天已完成"]) assert.match(todoHtml, new RegExp(heading));
  assert.match(todoHtml, /今天的正式任务/);

  const enabledSettings = await appRequest(harness.app, "https://dailynews.test/settings/todo", {
    headers: { cookie, accept: "text/html" },
  });
  const enabledSettingsHtml = await enabledSettings.text();
  assert.match(enabledSettingsHtml, /当前共有 1 项，其中 1 项未完成/);
  assert.doesNotMatch(enabledSettingsHtml, /今天的正式任务/);
  const disableConfirmation = await appRequest(harness.app, "https://dailynews.test/settings/todo/disable", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(disableConfirmation.status, 200);
  assert.match(await disableConfirmation.text(), /已有任务会完整保留/);
  assert.equal((await controlPool.query("SELECT enabled FROM app.todo_profiles WHERE space_id = $1", [space.id])).rows[0].enabled, true);

  const disabled = await appRequest(harness.app, "https://dailynews.test/settings/todo/disable", {
    method: "POST",
    headers: { cookie, origin: "https://dailynews.test", accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: agentSettings.body.csrfToken }).toString(),
  });
  assert.equal(disabled.status, 303);
  const hiddenTodo = await appRequest(harness.app, "https://dailynews.test/todo/", { headers: { cookie, accept: "text/html" } });
  assert.equal(hiddenTodo.status, 303);
  assert.equal(hiddenTodo.headers.get("location"), "/settings/todo?reason=todo-disabled");
  assert.equal((await controlPool.query("SELECT state_payload FROM app.todo_states WHERE space_id = $1", [space.id])).rowCount, 1);

  await controlPool.query(
    "UPDATE app.publications SET status = 'inactive', sort_order = NULL WHERE space_id = $1 AND publication_id = 'daily-news'",
    [space.id],
  );
  const retainedDaily = await appRequest(harness.app, "https://dailynews.test/p/daily-news/?date=2026-08-27", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(retainedDaily.status, 200);
  const retainedDailyHtml = await retainedDaily.text();
  assert.match(retainedDailyHtml, /正式主标题/);
  assert.match(retainedDailyHtml, /正式次标题/);
  await controlPool.query(
    "UPDATE app.publications SET status = 'active', sort_order = 0 WHERE space_id = $1 AND publication_id = 'daily-news'",
    [space.id],
  );

  await controlPool.query(
    "UPDATE app.theme_selections SET theme_id = 'missing-theme' WHERE space_id = $1 AND target_type = 'home'",
    [space.id],
  );
  const incompleteTheme = await appRequest(harness.app, "https://dailynews.test/home", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(incompleteTheme.status, 503);
  assert.doesNotMatch(await incompleteTheme.text(), /正式主标题|今天的正式任务/);
});

test("bootstrap pairing refreshes, claims once, verifies once, and persists no plaintext secret", async () => {
  const harness = createHarness();
  const signedOutSettings = await appRequest(harness.app, "https://dailynews.test/settings/agent", {
    headers: { accept: "text/html" },
  });
  assert.equal(signedOutSettings.status, 303);
  assert.equal(signedOutSettings.headers.get("location"), "/login?returnTo=%2Fsettings%2Fagent");
  const cookie = await signIn(harness, "pairing@example.com");
  assert.equal((await appRequest(harness.app, "https://dailynews.test/", { headers: { cookie } })).status, 200);

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
  const agentSettingsPage = await appRequest(harness.app, "https://dailynews.test/settings/agent", {
    headers: { cookie, accept: "text/html" },
  });
  assert.equal(agentSettingsPage.status, 200);
  const agentSettingsHtml = await agentSettingsPage.text();
  assert.match(agentSettingsHtml, /Codex &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(agentSettingsHtml, /Codex <script>/);
  assert.equal((await appRequest(harness.app, "https://dailynews.test/", {
    headers: { authorization: `Bearer ${claimed.token}` },
  })).status, 200);

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
  assert.equal((await appRequest(harness.app, "https://dailynews.test/", { headers: { cookie } })).status, 200);
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
    homePromise = appRequest(harness.app, "https://dailynews.test/home", { headers: { cookie } });
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
  assert.equal((await appRequest(harness.app, "https://dailynews.test/", { headers: { cookie } })).status, 200);
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
