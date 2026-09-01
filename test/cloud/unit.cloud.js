import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
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
import {
  renderAccountSettingsPage,
  renderAdvancedAccessPage,
  parseTodoAnchorHash,
  renderAgentSettingsPage,
  renderCredentialSecretPage,
  renderDailyPage,
  renderHomePage,
  renderLoginPage,
  renderNicknameOnboardingPage,
  renderOnboardingPage,
  renderPublicationsPage,
  renderPublicPage,
  renderTodoPage,
  renderSitesPage,
  renderThemeCatalogPage,
} from "../../.cloud-dist/src/web/react/render.js";
import {
  CanonicalJsonError,
  canonicalJson,
  jsonSha256,
} from "../../.cloud-dist/src/modules/shared/canonical-json.js";
import {
  constantTimeDigestEquals,
  digestAgentTokenSecret,
  issueAgentToken,
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
import { DAILYNEWS_MCP_INSTRUCTIONS } from "../../.cloud-dist/src/protocols/mcp/server.js";
import { createPostgresTodoStorage } from "../../.cloud-dist/src/adapters/postgres/todo.js";
import { PostgresTenancyStore } from "../../.cloud-dist/src/adapters/postgres/tenancy.js";
import { PrivateReadingService } from "../../.cloud-dist/src/modules/private-reading/service.js";
import { compileIssue } from "../../scripts/lib/compiler.js";
import { buildDailyReadingProjection } from "../../scripts/lib/domain/daily-reading.js";

const validProductConfig = {
  schemaVersion: 1,
  defaults: {
    spaceName: "我的日报",
    timeZone: "Asia/Shanghai",
    publicationId: "daily-news",
    publicationName: "DailyNews",
    theme: { id: "newspaper-default", revision: 1, colorScheme: "light" },
    todoEnabled: false,
    todoHasFormalData: false,
    priorityLimits: { lead: 1, important: 2, normal: null },
  },
  limits: {
    publicationsPerSpace: 8,
    customThemesPerSpace: 24,
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
    requestBodyLimitBytes: 16384,
    rateLimitRetentionHours: 24,
    auditRetentionDays: 90,
    apiRequestBodyLimitBytes: 262144,
    mcpRequestBodyLimitBytes: 262144,
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
  assert.equal(config.product.agentAccess.mcpRequestBodyLimitBytes, 262144);
});

test("M5.1-B React reading renderers expose the fixed navigation, publication index, formal dates, sources, images, and inactive state", async () => {
  const shell = {
    spaceName: "丁丁的编辑部",
    timeZone: "Asia/Shanghai",
    publication: { publicationId: "daily-news", displayName: "AI 日报", status: "active", isDefault: true, sortOrder: 0, spaceId: "space" },
    theme: { id: "newspaper-default", revision: 1 },
    todoEnabled: true,
    todoHasFormalData: true,
    nickname: "丁丁",
  };
  const additional = [{
    publication: { publicationId: "product-watch", displayName: "产品观察", status: "active", isDefault: false, sortOrder: 1, spaceId: "space" },
    latest: { date: "2026-08-28", title: "第二份日报的正式主标题" },
  }];
  const home = renderHomePage({
    basePath: "/cloud",
    shell,
    daily: null,
    publications: additional,
    todoProjection: { homeItems: [{ id: "todo-a1b2c3d4", title: "正式待办", dueDate: null }] },
  });
  const expectedNavigation = ["总览", "我的日报", "Todo", "编辑部设置"];
  for (const [index, label] of expectedNavigation.entries()) {
    const position = home.indexOf(`>${label}<`);
    assert.ok(position > -1);
    if (index > 0) assert.ok(position > home.indexOf(`>${expectedNavigation[index - 1]}<`));
  }
  assert.match(home, /产品观察/);
  assert.match(home, /第二份日报的正式主标题/);
  assert.match(home, /正式待办/);
  assert.doesNotMatch(home, /日报名称.*AI 日报.*产品观察/s);
  assert.match(home, /data-page="home"/);
  assert.match(home, /\/cloud\/assets\/m5\/m5-client\.js/);
  assert.match(home, /\/cloud\/assets\/themes\/newspaper-default\/1\.css/);
  assert.doesNotMatch(home, /assets\/cloud\.css|assets\/private-pages\.js/);

  const directory = renderPublicationsPage({
    basePath: "/cloud",
    shell,
    publications: [{ publication: shell.publication, latest: null }, ...additional],
  });
  assert.match(directory, /我的日报/);
  assert.match(directory, /首要日报/);
  assert.match(directory, /第一份正式日报还没有到达/);
  assert.doesNotMatch(directory, /<form|配置日报|上移|下移/);

  const issue = {
    schemaVersion: 2,
    date: "2026-08-29",
    generatedAt: "2026-08-29T08:00:00+08:00",
    coverage: { start: "2026-08-28T08:00:00+08:00", end: "2026-08-29T08:00:00+08:00" },
    revision: 1,
    items: [{
      id: "multi-source-story",
      title: "多来源正式内容",
      brief: "正式短摘要",
      summary: "正式完整摘要。",
      category: "测试",
      editorial: { priority: "lead", selectionReason: "验证阅读体验" },
      image: { src: "https://images.example.test/formal.jpg", alt: "虚构正式配图", width: 1200, height: 800, credit: "虚构图片来源", sourceUrl: "https://images.example.test/source" },
      sources: [
        { name: "主要来源", url: "https://example.test/primary" },
        { name: "补充来源", url: "https://example.test/secondary", originalTitle: "Original title" },
      ],
    }],
  };
  const compiled = compileIssue(issue).compiled;
  const daily = { date: issue.date, issue, compiled, projection: buildDailyReadingProjection(compiled, issue), dates: [issue.date, "2026-08-28"] };
  const dailyHtml = renderDailyPage({ basePath: "/cloud", shell: { ...shell, publication: { ...shell.publication, status: "inactive", sortOrder: null, isDefault: false } }, daily });
  assert.match(dailyHtml, /已停用 · 只读归档/);
  assert.match(dailyHtml, /2026-08-28/);
  assert.match(dailyHtml, /data-react-island="image-fallback"/);
  assert.match(dailyHtml, /m51-story--span-4/);
  assert.doesNotMatch(dailyHtml, /style="--(?:module-span|row-capacity)/);
  const darkDailyHtml = renderDailyPage({ basePath: "/cloud", shell: { ...shell, theme: { id: "midnight-tech", revision: 1, colorScheme: "dark" } }, daily });
  assert.match(darkDailyHtml, /<html lang="zh-CN" data-theme="dark" data-color-scheme="dark">/);
  assert.match(darkDailyHtml, /<meta name="color-scheme" content="dark"\s*\/>/);
  assert.match(dailyHtml, /referrerPolicy="no-referrer"/);
  assert.match(dailyHtml, /data-react-island="sources"/);
  assert.match(dailyHtml, /<dialog class="m51-source-dialog"/);
  assert.match(dailyHtml, /<button[^>]*class="m51-source-action"[^>]*hidden=""[^>]*>查看全部 2 个来源<\/button>/);
  assert.match(dailyHtml, /<a class="m51-source-action" href="#sources-multi-source-story">查看全部 2 个来源<\/a>/);
  assert.match(dailyHtml, />打开原文<\/span><svg/);
  assert.doesNotMatch(dailyHtml, />打开原文 <svg/);
  assert.match(dailyHtml, /href="#sources-multi-source-story"/);
  assert.match(dailyHtml, /class="m51-source-archive"/);
  assert.match(dailyHtml, /补充来源/);

  const missing = renderDailyPage({ basePath: "/cloud", shell, daily: null, dates: [issue.date], requestedDate: "2026-08-27" });
  assert.match(missing, /这一天没有正式日报/);
  assert.match(missing, /没有替你回退/);
  assert.match(missing, /阅读最近一期 · 2026-08-29/);

  const todoHtml = renderTodoPage({
    basePath: "/cloud",
    shell,
    projection: {
      asOfDate: "2026-08-29",
      groups: {
        overdue: [{ id: "todo-a1b2c3d4", title: "需要处理的正式待办", note: "仅展示正式 State", dueDate: "2026-08-28", dueTime: null }],
        today: [], upcoming: [], undated: [], completedToday: [],
      },
    },
  });
  assert.match(todoHtml, /data-page="todo"/);
  assert.match(todoHtml, /data-react-island="todo-anchor"/);
  assert.match(todoHtml, /需要处理的正式待办/);
  assert.doesNotMatch(todoHtml, /<form|checkbox|拖动/);
  assert.deepEqual(parseTodoAnchorHash(""), { kind: "none" });
  assert.deepEqual(parseTodoAnchorHash("#todo-a1b2c3d4"), { kind: "valid", id: "todo-a1b2c3d4" });
  assert.deepEqual(parseTodoAnchorHash("#%E4%BB%8A%E5%A4%A9"), { kind: "valid", id: "今天" });
  assert.deepEqual(parseTodoAnchorHash("#%E0%A4%AA"), { kind: "valid", id: "प" });
  assert.deepEqual(parseTodoAnchorHash("#%E0%A4%A"), { kind: "invalid" });
  assert.deepEqual(parseTodoAnchorHash("#"), { kind: "invalid" });

  const islands = await readFile(new URL("../../src/web/react/reading-islands.tsx", import.meta.url), "utf8");
  assert.match(islands, /dialogRef\.current\?\.showModal\(\)/);
  assert.match(islands, /triggerRef\.current\?\.focus\(\)/);
  assert.match(islands, /image\.complete && image\.naturalWidth === 0/);
  for (const retiredPath of [
    "../../src/web/private-pages.js",
    "../../src/web/private-pages.ts",
    "../../src/web/cloud-pages.ts",
    "../../src/web/cloud-auth.js",
    "../../src/web/cloud.css",
    "../../tokens.css",
  ]) {
    await assert.rejects(() => readFile(new URL(retiredPath, import.meta.url), "utf8"), { code: "ENOENT" });
  }
  const css = await readFile(new URL("../../src/web/react/reading.css", import.meta.url), "utf8");
  assert.match(css, /Ecosystem Index \+ Editorial Reading Flow/);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.m51-source-action\[hidden\]\s*\{\s*display: none;/);
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
  for (const CLOUD_HOST of ["0.0.0.0", "::", "dailynews.test"]) {
    await assert.rejects(
      () => loadWithEnvironment({
        CLOUD_ORIGIN: "http://127.0.0.1:3000",
        CLOUD_HOST,
        DATABASE_URL: "postgresql://u:p@db:5432/name",
      }),
      (error) => error instanceof CloudConfigError && /loopback HTTP CLOUD_ORIGIN/.test(error.message),
    );
  }
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
  assert.match(html, /\/cloud\/assets\/m5\/m5-client\.js/);
  assert.match(html, /\/cloud\/assets\/m5\/m5\.css/);
  assert.match(html, /data-react-island="login"/);
  assert.match(html, /autocomplete="email"/i);
  assert.doesNotMatch(html, /localStorage|sessionStorage|邮箱不存在|已注册/);
});

test("M5.1 first-use React journey stays API-first and keeps one-time secrets isolated", async () => {
  const shell = {
    spaceName: "我的日报",
    timeZone: "Asia/Shanghai",
    publication: { publicationId: "daily-news", displayName: "DailyNews", status: "active", isDefault: true, sortOrder: 0, spaceId: "space" },
    theme: { id: "newspaper-default", revision: 1, colorScheme: "light" },
    todoEnabled: false,
    todoHasFormalData: false,
    nickname: "丁丁",
  };
  const onboarding = renderOnboardingPage({
    basePath: "/cloud",
    shell,
    csrfToken: "csrf-placeholder",
    operationId: "operation-placeholder",
    setupUrl: "https://dailynews.test/cloud/agent-setup.md",
  });
  assert.match(onboarding, /data-react-island="copy-instruction"/);
  assert.match(onboarding, /https:\/\/dailynews\.test\/cloud\/agent-setup\.md/);
  assert.match(onboarding, /HTTPS JSON API/);
  assert.doesNotMatch(onboarding, /MCP 工具发现|MCP 工具|配对码/);
  assert.doesNotMatch(onboarding, /dn_pat_|Bearer /);

  const settings = renderAgentSettingsPage({
    basePath: "/cloud",
    shell,
    credentials: [],
    csrfToken: "csrf-placeholder",
    operationId: "operation-placeholder",
    activeLimit: 10,
  });
  assert.match(settings, /data-page="agent-settings"/);
  assert.match(settings, /<nav[^>]*>[\s\S]*日报站点[\s\S]*主题库[\s\S]*Agent 授权[\s\S]*账户与安全[\s\S]*高级接入/);
  assert.doesNotMatch(settings, /assets\/cloud\.css|assets\/private-pages\.js/);
  assert.doesNotMatch(settings, /assets\/themes\//);

  const secret = renderCredentialSecretPage({
    basePath: "/cloud",
    shell,
    token: "dn_pat_test-only-placeholder",
    title: "Agent Token 已创建",
  });
  assert.match(secret, /data-react-island="copy-secret"/);
  assert.match(secret, /id="agent-token-secret">dn_pat_test-only-placeholder/);
  assert.match(secret, /data-return-path="\/cloud\/settings\/agent"/);

  await assert.rejects(() => readFile(new URL("../../src/web/private-pages.ts", import.meta.url), "utf8"), { code: "ENOENT" });
});

test("M5.1 public page and sample Home use the editorial React shell", () => {
  const publicHtml = renderPublicPage({ basePath: "/cloud", signedIn: false });
  assert.match(publicHtml, /每天一份，.*只为你而编的.*私人日报。/s);
  assert.match(publicHtml, /把每天关心的事交给 Agent/);
  assert.match(publicHtml, /private-newsroom\.png/);
  assert.match(publicHtml, /width="1400" height="466"/);
  assert.match(publicHtml, /\/cloud\/login/);
  assert.match(publicHtml, /data-page="public"/);
  assert.doesNotMatch(publicHtml, /assets\/cloud\.css|assets\/private-pages\.js/);

  const shell = {
    spaceName: "我的日报",
    timeZone: "Asia/Shanghai",
    publication: { publicationId: "daily-news", displayName: "DailyNews", status: "active", isDefault: true, sortOrder: 0, spaceId: "space" },
    theme: { id: "newspaper-default", revision: 1 },
    todoEnabled: false,
  };
  const homeHtml = renderHomePage({ basePath: "/cloud", shell, daily: null });
  assert.match(homeHtml, /示例日报/);
  assert.match(homeHtml, /系统内置 · 不代表今日/);
  assert.match(homeHtml, /设置自动日报/);
  assert.doesNotMatch(homeHtml, /下次更新时间|负责 Agent|调度健康|迟到|Candidate/);
  assert.match(homeHtml, /data-theme-id="newspaper-default"/);

  const homeWithMore = renderHomePage({
    basePath: "/cloud",
    shell: { ...shell, todoEnabled: true, todoHasFormalData: true },
    daily: null,
    publications: [{
      publication: { ...shell.publication, publicationId: "other-daily", displayName: "其他日报", isDefault: false, sortOrder: 1 },
      latest: null,
    }],
    todoProjection: { homeItems: [{ id: "todo-a1b2c3d4", title: "完成验收", dueDate: "2026-09-02" }] },
  });
  assert.match(homeWithMore, /m51-home-stage.*m51-home-illustration[^>]*><img[^>]*><\/div><\/div><section class="m51-home-index"/s);
  assert.match(homeWithMore, /m51-home-index.*m51-home-todo/s);
});

test("M5.1-C React settings shell exposes exactly five sections and keeps nickname independent from site names", () => {
  const shell = {
    spaceName: "Home 名称",
    timeZone: "Asia/Shanghai",
    publication: { publicationId: "daily-news", displayName: "日报名称", status: "active", isDefault: true, sortOrder: 0, spaceId: "space" },
    theme: { id: "newspaper-default", revision: 1 },
    todoEnabled: false,
    nickname: "丁丁",
  };
  const account = renderAccountSettingsPage({
    basePath: "/cloud",
    shell,
    csrfToken: "csrf-placeholder",
    profile: { userId: "user", email: "reader@example.test", nickname: "丁丁", complete: true },
  });
  for (const label of ["日报站点", "主题库", "Agent 授权", "账户与安全", "高级接入"]) {
    assert.match(account, new RegExp(`>${label}<`));
  }
  assert.equal((account.match(/class="m51-settings-index"/g) ?? []).length, 1);
  assert.match(account, /aria-label="账户：丁丁"/);
  assert.match(account, /reader@example\.test/);
  assert.match(account, /邮箱验证码/);
  assert.doesNotMatch(account, /settings\/todo|manual-tokens|Home 名称|日报名称.*昵称/);
  assert.match(account, /data-react-island="logout"/);
  assert.match(account, /\/cloud\/assets\/m5\/m5-client\.js/);
  assert.doesNotMatch(account, /assets\/cloud\.css|assets\/private-pages\.js/);

  const onboarding = renderNicknameOnboardingPage({ basePath: "/cloud", shell: { ...shell, nickname: null }, csrfToken: "csrf-placeholder", nickname: " 保留输入 " , error: "昵称需要是 1–24 个可见字符。" });
  assert.match(onboarding, /value=" 保留输入 "/);
  assert.match(onboarding, /昵称需要是 1–24 个可见字符/);
  assert.doesNotMatch(onboarding, /配对码|PAT|MCP/);
});

test("M5.1-C site and theme renderers preserve real forms while replacing placeholder theme blocks with fixed-content previews", () => {
  const shell = {
    spaceName: "丁丁的编辑部",
    timeZone: "Asia/Shanghai",
    publication: { publicationId: "daily-news", displayName: "AI 日报", status: "active", isDefault: true, sortOrder: 0, spaceId: "space" },
    theme: { id: "newspaper-default", revision: 1, colorScheme: "light" },
    todoEnabled: false,
    todoHasFormalData: false,
    nickname: "丁丁",
  };
  const themes = [
    { themeId: "newspaper-default", name: "经典报纸", source: "official", revision: 1, preview: { background: "#f5f1e9", text: "#12100d", muted: "#69635a", accent: "#e85a18", rule: "#c9c1b5" } },
    { themeId: "editorial-night", name: "夜间 <编辑部>", source: "custom", revision: 2, preview: { background: "#171717", text: "#f5f1e9", muted: "#aaaaaa", accent: "#ef6b35", rule: "#555555" } },
  ];
  const snapshot = {
    home: { name: "我的日报", themeId: "newspaper-default" },
    publications: [
      { publicationId: "daily-news", name: "AI 日报", status: "active", sortOrder: 0, isPrimary: true, theme: { mode: "inherit" } },
      { publicationId: "archive-news", name: "归档日报", status: "inactive", sortOrder: null, isPrimary: false, theme: { mode: "override", themeId: "editorial-night" } },
    ],
    todo: { enabled: false, hasFormalData: true },
  };
  const sites = renderSitesPage({ basePath: "/cloud", shell, snapshot, themes, csrfToken: "csrf-placeholder", publicationLimit: 8 });
  assert.match(sites, /data-page="settings"/);
  assert.match(sites, /m51-site-card/);
  assert.match(sites, /上移 AI 日报/);
  assert.match(sites, /<svg/);
  assert.match(sites, /Personal Todo/);
  assert.match(sites, /已保留正式 Todo 数据，本页不读取任务正文/);
  assert.match(sites, /把重要信息排在前面/);
  assert.match(sites, /三条与你有关的更新/);
  assert.doesNotMatch(sites, /<i><\/i><b><\/b><em><\/em><small><\/small>/);
  assert.doesNotMatch(sites, /assets\/cloud\.css|assets\/private-pages\.js/);

  const catalog = renderThemeCatalogPage({ basePath: "/cloud", shell, themes });
  assert.match(catalog, /经典报纸/);
  assert.match(catalog, /夜间 &lt;编辑部&gt;/);
  assert.doesNotMatch(catalog, /夜间 <编辑部>/);
  assert.equal((catalog.match(/把重要信息排在前面/g) ?? []).length, 2);
  assert.match(catalog, /--m51-preview-background:#171717/);

  const advanced = renderAdvancedAccessPage({ basePath: "/cloud", shell, apiBaseUrl: "https://dailynews.test/cloud/api/v1", mcpUrl: "https://dailynews.test/cloud/mcp" });
  assert.match(advanced, /https:\/\/dailynews\.test\/cloud\/api\/v1/);
  assert.match(advanced, /https:\/\/dailynews\.test\/cloud\/mcp/);
  assert.doesNotMatch(advanced, /assets\/cloud\.css|assets\/private-pages\.js/);
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

test("M5.1 client assets are served only from the configured base path and fixed build root", async () => {
  const app = createCloudApp({
    basePath: "/cloud",
    readinessCheck: async () => {},
    identity: { getSession: async () => null, handle: () => new Response(null, { status: 404 }) },
    tenancy: {},
    defaults: validProductConfig.defaults,
  });
  assert.equal((await app.request("https://dailynews.test/assets/m5/m5.css")).status, 404);
  const css = await app.request("https://dailynews.test/cloud/assets/m5/m5.css");
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(css.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.ok(css.headers.get("etag"));
  const cssText = await css.text();
  assert.match(cssText, /--m51-paper:/);
  assert.doesNotMatch(cssText, /@font-face|\.woff2?/);
  const client = await app.request("https://dailynews.test/cloud/assets/m5/m5-client.js");
  assert.equal(client.status, 200);
  assert.equal(client.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(client.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.ok(client.headers.get("etag"));
  for (const retiredAsset of ["private-pages.js", "cloud.css", "cloud-auth.js", "tokens.css"]) {
    assert.equal((await app.request(`https://dailynews.test/cloud/assets/${retiredAsset}`)).status, 404);
  }
  assert.equal((await app.request("https://dailynews.test/cloud/assets/m5/%2e%2e%2fcloud.css")).status, 404);
  assert.equal((await app.request("https://dailynews.test/cloud/assets/m5/not-allowed.txt")).status, 404);
  assert.equal((await app.request("https://dailynews.test/cloud/assets/m5/retired.woff2")).status, 404);

  const server = createAdaptorServer({ fetch: app.fetch, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cssUrl = new URL(`/cloud/assets/m5/m5.css`, `http://127.0.0.1:${address.port}`);
    const networkCss = await fetch(cssUrl);
    assert.equal(networkCss.status, 200);
    const networkEtag = networkCss.headers.get("etag");
    assert.ok(networkEtag);
    const unchangedCss = await fetch(cssUrl, { headers: { "If-None-Match": networkEtag } });
    assert.equal(unchangedCss.status, 304);
    assert.equal(unchangedCss.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal((await unchangedCss.arrayBuffer()).byteLength, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const incompleteRuntime = createCloudApp({
    basePath: "/cloud",
    readinessCheck: async () => {},
    identity: {
      getSession: async () => ({ user: { id: "user" }, session: { id: "session" } }),
      handle: () => new Response(null, { status: 404 }),
    },
    tenancy: { ensureSpaceForUser: async () => ({ spaceId: "space" }) },
    defaults: validProductConfig.defaults,
  });
  const incompleteHome = await incompleteRuntime.request("https://dailynews.test/cloud/home");
  assert.equal(incompleteHome.status, 503);
  assert.doesNotMatch(await incompleteHome.text(), /M2 云端|Space 摘要|assets\/cloud\.css/);
});

test("Agent setup exposes only the API-first Markdown contracts at the configured base path", async () => {
  const createApp = (basePath, apiBaseUrl) => createCloudApp({
    basePath,
    readinessCheck: async () => {},
    agentSettings: {
      origin: "https://dailynews.test",
      csrfSecret: "agent-setup-test-secret",
      service: {},
      digestActor: () => "unused",
      apiBaseUrl,
      mcpUrl: `https://dailynews.test${basePath}/mcp`,
      activeCredentialLimit: 10,
      requestBodyLimitBytes: 16384,
    },
  });
  const documentPaths = [
    "/agent-setup.md",
    "/agent-setup/content.md",
    "/agent-setup/todo.md",
    "/agent-setup/theme.md",
  ];

  const basePath = "/dailynews";
  const apiBaseUrl = "https://dailynews.test/dailynews/api/v1";
  const app = createApp(basePath, apiBaseUrl);
  for (const path of documentPaths) {
    assert.equal((await app.request(`https://dailynews.test${path}`)).status, 404);
  }

  const rendered = new Map();
  for (const path of documentPaths) {
    const response = await app.request(`https://dailynews.test${basePath}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    rendered.set(path, await response.text());
  }

  const indexMarkdown = rendered.get("/agent-setup.md");
  assert.match(indexMarkdown, /^---\nname: dailynews\nversion: 4\.0\.0\n/);
  assert.match(indexMarkdown, new RegExp(`api_base: "${apiBaseUrl.replaceAll("/", "\\/")}"`));
  assert.match(indexMarkdown, /\]\(\.\/agent-setup\/content\.md\)/);
  assert.match(indexMarkdown, /\]\(\.\/agent-setup\/todo\.md\)/);
  assert.match(indexMarkdown, /\]\(\.\/agent-setup\/theme\.md\)/);
  assert.doesNotMatch(indexMarkdown, /状态：|实现阶段：|更新日期：/);

  const contentMarkdown = rendered.get("/agent-setup/content.md");
  assert.match(contentMarkdown, /\/publications`/);
  assert.match(contentMarkdown, /\/publications\/\{publicationId\}\/daily-context/);
  assert.match(contentMarkdown, /\/publications\/\{publicationId\}\/daily-candidates/);
  assert.match(contentMarkdown, /\/publications\/\{publicationId\}\/issues\/\{date\}/);
  assert.match(contentMarkdown, /Authorization: Bearer/);
  assert.match(contentMarkdown, /Content-Type: application\/json/);
  assert.match(contentMarkdown, /Idempotency-Key/);
  assert.match(contentMarkdown, /"mode": "update"/);
  assert.match(contentMarkdown, /"confirmation"/);
  assert.match(contentMarkdown, /"candidate"/);

  const todoMarkdown = rendered.get("/agent-setup/todo.md");
  assert.match(todoMarkdown, /GET .*\/todo`/);
  assert.match(todoMarkdown, /POST .*\/todo\/candidates`/);
  assert.match(todoMarkdown, /baseRevision/);
  assert.match(todoMarkdown, /revision_conflict/);
  assert.doesNotMatch(todoMarkdown, /\/publications|\/themes/);

  const themeMarkdown = rendered.get("/agent-setup/theme.md");
  assert.match(themeMarkdown, /GET .*\/themes\/context`/);
  assert.match(themeMarkdown, /GET .*\/themes\/\{themeId\}`/);
  assert.match(themeMarkdown, /POST .*\/themes`/);
  assert.match(themeMarkdown, /PUT .*\/themes\/\{themeId\}`/);
  assert.match(themeMarkdown, /DELETE .*\/themes\/\{themeId\}`/);
  assert.match(themeMarkdown, /baseRevision/);
  assert.match(themeMarkdown, /If-Match/);
  assert.doesNotMatch(themeMarkdown, /\/publications|\/todo/);

  for (const markdown of rendered.values()) {
    assert.ok(markdown.includes(apiBaseUrl));
    assert.doesNotMatch(markdown, /\{\{[^{}]+\}\}/);
    assert.doesNotMatch(markdown, /\bmcp\b|mcp_servers|config\.toml|Claim|Verify|配对|provisioning|instructionsVersion|dailynews-agent-setup\.json/i);
    assert.doesNotMatch(markdown, /dnpat_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/);
  }

  assert.equal((await app.request(
    "https://dailynews.test/dailynews/agent-setup/codex.md",
  )).status, 404);
  assert.equal((await app.request(
    "https://dailynews.test/dailynews/agent-setup/unknown.md",
  )).status, 404);
  assert.equal((await app.request(
    "https://dailynews.test/dailynews/.well-known/dailynews-agent-setup.json",
  )).status, 404);

  const rootApiBaseUrl = "https://dailynews.test/api/v1";
  const rootApp = createApp("", rootApiBaseUrl);
  for (const path of documentPaths) {
    const response = await rootApp.request(`https://dailynews.test${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.ok((await response.text()).includes(rootApiBaseUrl));
    assert.equal((await rootApp.request(`https://dailynews.test/dailynews${path}`)).status, 404);
  }
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

test("active PAT authentication treats the Bearer scheme case-insensitively and rejects revoked credentials", async () => {
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
    activeCredentialLimit: 10,
  });
  assert.equal((await service.authenticateActiveToken(`bearer ${issued.token}`)).id, credential.id);
  credential.status = "revoked";
  await assert.rejects(() => service.authenticateActiveToken(`Bearer ${issued.token}`), (error) => error.status === 401);
});

test("invalid Token names fail before the repository can create a credential", async () => {
  let credentialInsertCalls = 0;
  const service = new AgentCredentialService({
    issueCredential: async () => {
      credentialInsertCalls += 1;
      throw new Error("credential insert must not run");
    },
  }, {
    tokenDigestSecret: "agent-token-unit-secret-with-at-least-32-characters",
    activeCredentialLimit: 10,
  });

  await assert.rejects(
    () => service.issueCredential(
      { spaceId: "space-a", userId: "user-a" },
      { name: "\n", operationId: "00000000-0000-4000-8000-000000000001" },
      "req_invalid_token_name",
      "actor-digest",
    ),
    (error) => error?.code === "invalid_request",
  );
  assert.equal(credentialInsertCalls, 0);
});

test("settings CSRF tokens bind to one session and user", () => {
  const secret = "settings-csrf-unit-secret-with-at-least-32-characters";
  const token = createSettingsCsrfToken(secret, "session-a", "user-a");
  assert.ok(verifySettingsCsrfToken(secret, "session-a", "user-a", token));
  assert.equal(verifySettingsCsrfToken(secret, "session-b", "user-a", token), false);
  assert.equal(verifySettingsCsrfToken(secret, "session-a", "user-b", token), false);
  assert.equal(verifySettingsCsrfToken(secret, "session-a", "user-a", `${token}x`), false);
});

test("settings mutations accept optional opaque browser Origin while preserving transport, CSRF, media, and size boundaries", async () => {
  const secret = "settings-request-secret-with-at-least-32-characters";
  const csrf = createSettingsCsrfToken(secret, "session-a", "user-a");
  const validRequest = new Request("https://dailynews.test/settings/agent/tokens", {
    method: "POST",
    headers: { origin: "https://dailynews.test", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, name: "Agent" }),
  });
  const body = await readSettingsBody(validRequest.clone(), 1024);
  const mutationRequest = (origin) => new Request("https://dailynews.test/settings/agent/tokens", {
    method: "POST",
    headers: origin === undefined ? {} : { origin },
  });
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
  for (const origin of [undefined, "null"]) {
    assert.doesNotThrow(() => assertBrowserMutation({
      request: mutationRequest(origin),
      requestOrigin: "https://dailynews.test",
      configuredOrigin: "https://dailynews.test",
      csrfSecret: secret,
      sessionId: "session-a",
      userId: "user-a",
      body,
    }));
  }
  assert.throws(() => assertBrowserMutation({
    request: mutationRequest("https://attacker.test"),
    requestOrigin: "https://dailynews.test",
    configuredOrigin: "https://dailynews.test",
    csrfSecret: secret,
    sessionId: "session-a",
    userId: "user-a",
    body,
  }), (error) => error.status === 403);
  for (const origin of ["", "NULL"]) {
    assert.throws(() => assertBrowserMutation({
      request: mutationRequest(origin),
      requestOrigin: "https://dailynews.test",
      configuredOrigin: "https://dailynews.test",
      csrfSecret: secret,
      sessionId: "session-a",
      userId: "user-a",
      body,
    }), (error) => error.status === 403);
  }
  assert.throws(() => assertBrowserMutation({
    request: mutationRequest("null"),
    requestOrigin: null,
    configuredOrigin: "https://dailynews.test",
    csrfSecret: secret,
    sessionId: "session-a",
    userId: "user-a",
    body,
  }), (error) => error.status === 403);
  assert.throws(() => assertBrowserMutation({
    request: mutationRequest("null"),
    requestOrigin: "https://dailynews.test",
    configuredOrigin: "https://dailynews.test",
    csrfSecret: secret,
    sessionId: "session-a",
    userId: "user-a",
    body: { ...body, _csrf: "invalid" },
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
    requestUrl: "http://dailynews.test/settings/agent/tokens",
    requestHost: "dailynews.test",
    transportProtocol: "http",
    configuredOrigin: "https://dailynews.test",
    remoteAddress: "127.0.0.1",
    forwardedProto: "https",
  }), "https://dailynews.test");
  assert.equal(resolveTrustedExternalOrigin({
    requestUrl: "http://127.0.0.1:3000/mcp",
    requestHost: "127.0.0.1:3000",
    transportProtocol: "http",
    configuredOrigin: "http://127.0.0.1:3000",
    remoteAddress: "203.0.113.20",
    forwardedProto: undefined,
  }), null);
  assert.equal(resolveTrustedExternalOrigin({
    requestUrl: "http://127.0.0.1:3000/mcp",
    requestHost: "127.0.0.1:3000",
    transportProtocol: "http",
    configuredOrigin: "http://127.0.0.1:3000",
    remoteAddress: "::ffff:127.0.0.1",
    forwardedProto: undefined,
  }), "http://127.0.0.1:3000");
  for (const input of [
    { remoteAddress: "203.0.113.20", forwardedProto: "https" },
    { remoteAddress: "127.0.0.1", forwardedProto: undefined },
    { remoteAddress: "127.0.0.1", forwardedProto: "https,http" },
    { remoteAddress: "127.0.0.1", forwardedProto: "http" },
  ]) {
    assert.equal(resolveTrustedExternalOrigin({
      requestUrl: "http://dailynews.test/settings/agent/tokens",
      requestHost: "dailynews.test",
      transportProtocol: "http",
      configuredOrigin: "https://dailynews.test",
      ...input,
    }), "http://dailynews.test");
  }
  assert.equal(resolveTrustedExternalOrigin({
    requestUrl: "https://dailynews.test/settings/agent/tokens",
    requestHost: "dailynews.test",
    transportProtocol: "http",
    configuredOrigin: "https://dailynews.test",
    remoteAddress: "127.0.0.1",
    forwardedProto: undefined,
  }), "http://dailynews.test");
  assert.equal(resolveTrustedExternalOrigin({
    requestUrl: "https://dailynews.test/settings/agent/tokens",
    requestHost: "dailynews.test",
    transportProtocol: "https",
    configuredOrigin: "https://dailynews.test",
    remoteAddress: "203.0.113.20",
    forwardedProto: undefined,
  }), "https://dailynews.test");
  for (const mismatch of [
    { requestUrl: "https://dailynews.test/settings/agent/tokens", requestHost: "attacker.test" },
    { requestUrl: "https://attacker.test/settings/agent/tokens", requestHost: "dailynews.test" },
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

test("HTTP adapter enforces the loopback TLS terminator for Agent Token browser mutations", async () => {
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
    "https://dailynews.test/settings/agent/tokens/credential-a/name",
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
  const request = (headers = {}, requestTarget = "/settings/agent/tokens/credential-a/name") => new Promise((resolve, reject) => {
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
  try {
    assert.equal((await noSocketRequest("dailynews.test")).status, 403);
    assert.equal((await noSocketRequest("attacker.test")).status, 403);
    assert.equal(await request(), 403);
    assert.equal(await request({ "x-forwarded-proto": "http" }), 403);
    assert.equal(await request({ "x-forwarded-proto": "https", origin: "https://attacker.test" }), 403);
    assert.equal(await request(
      {},
      "https://dailynews.test/settings/agent/tokens/credential-a/name",
    ), 403);
    assert.equal(await request(
      { "x-forwarded-proto": "https", host: "attacker.test" },
      "https://dailynews.test/settings/agent/tokens/credential-a/name",
    ), 403);
    assert.equal(await request({ "x-forwarded-proto": "https" }), 200);
    assert.equal(await request({ "x-forwarded-proto": "https" }, "/agent-pairing/v1/verify"), 404);
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
      return { enabled: false, settingsUrl: "https://dailynews.test/settings/sites#personal-todo" };
    },
    async getTodo() {
      return { enabled: false, settingsUrl: "https://dailynews.test/settings/sites#personal-todo" };
    },
    async getTodoState() {
      throw new Error("disabled Todo must not be read");
    },
    async submitTodoCandidate(_access, input) {
      calls.push({ type: "todo", input });
      return { result: "published", revision: 1 };
    },
    async getThemeContext() {
      return { themes: [] };
    },
    async getTheme(_access, themeId) {
      return { themeId, source: "custom", revision: 1, definition: {}, usage: { home: false, publications: [] } };
    },
    async createTheme(_access, input) {
      calls.push({ type: "create-theme", input });
      return { result: "created", themeId: input.theme.id, revision: 1, affected: { home: false, publications: [] } };
    },
    async updateTheme(_access, input) {
      calls.push({ type: "update-theme", input });
      return { result: "updated", themeId: input.themeId, revision: input.baseRevision + 1, affected: { home: false, publications: [] } };
    },
    async deleteTheme(_access, input) {
      calls.push({ type: "delete-theme", input });
      return { result: "deleted", themeId: input.themeId, revision: input.baseRevision, affected: { home: false, publications: [] } };
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

test("unmatched JSON API routes authenticate and use the stable request error envelope", async () => {
  const { app, calls } = agentApiTestApp();
  const response = await app.request("https://dailynews.test/cloud/api/v1/not-a-route", {
    headers: { authorization: "Bearer valid-token" },
  });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("x-request-id"), /^req_[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(await response.json()).sort(), ["error"]);
  const error = await app.request("https://dailynews.test/cloud/api/v1/still-missing", {
    headers: { authorization: "Bearer valid-token" },
  });
  const body = await error.json();
  assert.equal(body.error.code, "target_not_found");
  assert.equal(body.error.message, "没有找到 API 资源。");
  assert.match(body.error.requestId, /^req_[0-9a-f]{32}$/);
  assert.equal(calls.filter(({ type }) => type === "authenticate").length, 2);
  assert.ok(calls.filter(({ type }) => type === "authenticate").every(({ input }) => input.action === "read"));
});

test("disabled Todo reads only formal-data existence metadata and never retained state payload", async () => {
  const queries = [];
  let released = false;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/SELECT enabled\s+FROM app\.todo_profiles/.test(sql)) {
        return { rows: [{ enabled: false }], rowCount: 1 };
      }
      if (/todo_states|state_payload/.test(sql)) {
        throw new Error("disabled snapshot must not read retained Todo state");
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async query(sql) {
      if (/FROM app\.spaces/.test(sql)) {
        return {
          rows: [{ id: "space-disabled", user_id: "user-disabled", status: "ready" }],
          rowCount: 1,
        };
      }
      if (/EXISTS \(\s*SELECT 1\s*FROM app\.todo_states/.test(sql)) {
        queries.push(sql);
        return { rows: [{ enabled: false, has_formal_data: true }], rowCount: 1 };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };
  const tenancy = new PostgresTenancyStore(pool);
  const tenant = await tenancy.resolveTenantContextForSpace("space-disabled");
  assert.ok(tenant);
  const storage = createPostgresTodoStorage(pool, tenant);
  const snapshot = await storage.readSnapshot();
  assert.deepEqual(snapshot, { enabled: false, state: null });
  assert.deepEqual(await storage.readAvailability(), { enabled: false, hasFormalData: true });
  assert.equal(released, true);
  assert.ok(queries.some((sql) => sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert.ok(queries.some((sql) => sql === "COMMIT"));
  assert.ok(queries.every((sql) => !/state_payload/.test(sql)));
  assert.equal(queries.filter((sql) => /todo_states/.test(sql)).length, 1);
});

test("inactive owned Publications retain private access to existing formal Daily snapshots", async () => {
  const issue = {
    schemaVersion: 1,
    date: "2026-08-27",
    generatedAt: "2026-08-27T08:00:00+08:00",
    coverage: { start: "2026-08-26T08:00:00+08:00", end: "2026-08-27T08:00:00+08:00" },
    revision: 1,
    items: [{
      id: "retained-daily",
      title: "停用后保留的正式日报",
      brief: "保留摘要",
      summary: "Publication 停用后，所属用户仍可读取这份已经发布的正式日报内容。",
      category: "产品",
      editorial: { priority: "lead", selectionReason: "验证停用后的正式读取" },
      sources: [{ name: "正式来源", url: "https://example.com/retained" }],
    }],
  };
  const compiled = compileIssue(issue).compiled;
  const clientQueries = [];
  let connectCount = 0;
  const client = {
    async query(sql) {
      clientQueries.push(sql);
      if (/SELECT issue_date::text AS issue_date/.test(sql)) {
        return { rows: [{ issue_date: issue.date }], rowCount: 1 };
      }
      if (/SELECT i\.issue_payload, c\.compiled_payload/.test(sql)) {
        return { rows: [{ issue_payload: issue, compiled_payload: compiled }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    async query(sql, values) {
      if (/FROM app\.spaces/.test(sql)) {
        return { rows: [{ id: "space-reader", user_id: "user-reader", status: "ready" }], rowCount: 1 };
      }
      if (/SELECT 1\s+FROM app\.publications/.test(sql)) {
        return values[1] === "daily-news" ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/SELECT space_id, publication_id, display_name, status, sort_order/.test(sql)) {
        return {
          rows: [{
            space_id: "space-reader",
            publication_id: "daily-news",
            display_name: "DailyNews",
            status: "inactive",
            sort_order: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      connectCount += 1;
      return client;
    },
  };
  const tenancy = new PostgresTenancyStore(pool);
  const tenant = await tenancy.resolveTenantContextForSpace("space-reader");
  assert.ok(tenant);
  const service = new PrivateReadingService(pool, tenancy, { readThemeRevision: async () => null });
  const daily = await service.readDaily(tenant, "daily-news", issue.date);
  assert.equal(daily.issue.items[0].title, "停用后保留的正式日报");
  assert.equal(connectCount, 1);
  assert.ok(clientQueries.some((sql) => /SELECT i\.issue_payload, c\.compiled_payload/.test(sql)));

  const hidden = await service.readDaily(tenant, "other-space-publication", issue.date);
  assert.equal(hidden, null);
  assert.equal(connectCount, 1);
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

test("JSON API exposes equivalent Theme reads and idempotent mutation envelopes", async () => {
  const { app, calls } = agentApiTestApp();
  const headers = { authorization: "Bearer valid-token" };
  assert.equal((await app.request("https://dailynews.test/cloud/api/v1/themes/context", { headers })).status, 200);
  assert.equal((await app.request("https://dailynews.test/cloud/api/v1/themes/example-theme", { headers })).status, 200);

  const created = await app.request("https://dailynews.test/cloud/api/v1/themes", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": "theme-create-0001" },
    body: JSON.stringify({ theme: customTheme }),
  });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).themeId, "example-theme");

  const updated = await app.request("https://dailynews.test/cloud/api/v1/themes/example-theme", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": "theme-update-0001" },
    body: JSON.stringify({ baseRevision: 1, theme: customTheme }),
  });
  assert.equal(updated.status, 200);

  const invalidDelete = await app.request("https://dailynews.test/cloud/api/v1/themes/example-theme", {
    method: "DELETE",
    headers: { ...headers, "idempotency-key": "theme-delete-0001", "if-match": "2" },
  });
  assert.equal(invalidDelete.status, 400);

  const deleted = await app.request("https://dailynews.test/cloud/api/v1/themes/example-theme", {
    method: "DELETE",
    headers: { ...headers, "idempotency-key": "theme-delete-0001", "if-match": '"2"' },
  });
  assert.equal(deleted.status, 200);
  assert.ok(calls.filter(({ type }) => type === "authenticate").some(({ input }) => input.action === "write"));
  assert.ok(calls.some(({ type }) => type === "create-theme"));
  assert.ok(calls.some(({ type }) => type === "update-theme"));
  assert.ok(calls.some(({ type }) => type === "delete-theme"));
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
    .filter(({ method, path: routePath }) => (
      method !== "ALL"
      && !routePath.includes("*")
      && routePath.startsWith("/cloud/api/v1/")
    ))
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
  for (const { path: routePath, method } of AGENT_API_ROUTE_CONTRACT.filter(({ method }) => (
    method === "put" || method === "delete"
  ))) {
    const operation = specification.paths[routePath][method];
    assert.ok(operation.parameters.some(({ $ref }) => $ref === "#/components/parameters/IdempotencyKey"));
  }
  assert.ok(specification.paths["/themes/{themeId}"].delete.parameters.some(
    ({ $ref }) => $ref === "#/components/parameters/ThemeRevisionMatch",
  ));
  const errorCodes = specification.components.schemas.Error.properties.error.properties.code.enum;
  for (const code of [
    "invalid_token", "idempotency_conflict", "revision_conflict", "explicit_confirmation_required",
    "publication_inactive", "todo_disabled", "payload_too_large", "rate_limited", "service_unavailable",
    "theme_conflict", "theme_read_only", "theme_in_use", "theme_limit_reached",
  ]) assert.ok(errorCodes.includes(code));

  const schemas = specification.components.schemas;
  assert.ok(schemas.DailyContextResponse.required.includes("priorityLimits"));
  assert.ok(schemas.DailyContextResponse.properties.priorityLimits);
  for (const field of ["mode", "repaired", "warnings"]) {
    assert.ok(schemas.DailySubmissionResponse.properties[field], `Daily response must document ${field}`);
  }
  for (const field of [
    "schemaVersion", "candidateId", "baseRevision", "operationCount", "operations", "warnings", "processedAt",
  ]) {
    assert.ok(schemas.TodoSubmissionResponse.properties[field], `Todo response must document ${field}`);
    assert.ok(schemas.TodoSubmissionResponse.required.includes(field), `Todo response must require ${field}`);
  }

  const guide = await readFile(path.join(process.cwd(), "docs", "CLOUD_AGENT_ACCESS.md"), "utf8");
  assert.match(guide, /daily-candidates/);
  assert.match(guide, /todo\/candidates/);
  assert.match(guide, /Idempotency-Key/);
  assert.doesNotMatch(guide, /dnpat_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/);
});

function agentMcpTestApp(options = {}) {
  const origin = options.origin ?? "https://dailynews.test";
  const authentications = [];
  const calls = [];
  const publication = {
    publicationId: "daily-news",
    name: "DailyNews",
    isDefault: true,
    status: "active",
    writable: true,
  };
  const authenticator = {
    async authenticate(input) {
      authentications.push(input);
      if (input.authorization !== "Bearer valid-token") {
        throw new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
      }
      return {
        requestId: input.requestId,
        credentialId: "credential-one",
        credentialName: "MCP test",
        tenant: { spaceId: "space-one", ownerUserId: "user-one" },
      };
    },
  };
  const operations = {
    async listPublications() {
      calls.push(["listPublications"]);
      return { publications: [publication] };
    },
    async getDailyContext(_access, publicationId, date) {
      calls.push(["getDailyContext", publicationId, date]);
      return {
        publication,
        timeZone: "Asia/Shanghai",
        priorityLimits: { lead: 1, important: 2, normal: null },
        today: "2026-08-27",
        resolvedDate: date ?? "2026-08-27",
        issue: { exists: false, revision: null },
        writeRules: {
          contentSchemaVersions: [1, 2],
          maximumItems: 100,
          historicalConfirmationRequired: false,
          replaceRequiresExistingIssue: true,
          replaceExpectedRevision: null,
        },
      };
    },
    async submitDailyCandidate(_access, input) {
      calls.push(["submitDailyCandidate", input]);
      return {
        result: "created",
        publicationId: input.publicationId,
        date: input.candidate.date,
        revision: 1,
        mode: input.mode,
        warnings: [],
        pageUrl: "https://dailynews.test/p/daily-news/?date=2026-08-27",
      };
    },
    async getDailyIssue(_access, publicationId, date) {
      calls.push(["getDailyIssue", publicationId, date]);
      const issue = { ...structuredClone(dailyCandidate), revision: 1 };
      return {
        publicationId,
        date,
        revision: 1,
        issue,
        compiledEdition: {
          ...structuredClone(issue),
          layout: {
            rows: [{
              usedCapacity: 1,
              modules: [{
                itemId: "example-story",
                resolvedPriority: "normal",
                size: "small",
                span: 1,
                mediaVariant: "none",
              }],
            }],
          },
        },
        pageUrl: "https://dailynews.test/p/daily-news/?date=2026-08-27",
      };
    },
    async getTodoContext() {
      calls.push(["getTodoContext"]);
      return {
        enabled: true,
        candidateRules: { schemaVersion: 1, maximumOperations: 100 },
        settingsUrl: "https://dailynews.test/settings/sites#personal-todo",
        revision: 0,
      };
    },
    async submitTodoCandidate(_access, input) {
      calls.push(["submitTodoCandidate", input]);
      return {
        schemaVersion: 1,
        candidateId: input.candidate.candidateId,
        result: "published",
        baseRevision: 0,
        revision: 1,
        operationCount: 1,
        operations: [{ index: 0, type: "add", result: "created", taskId: "todo-1234abcd" }],
        warnings: [],
        processedAt: "2026-08-27T09:00:00+08:00",
        pageUrl: "https://dailynews.test/todo/",
      };
    },
    async getTodoState() {
      calls.push(["getTodoState"]);
      if (options.todoDisabled) {
        throw new AgentRequestError(409, "todo_disabled", "Personal Todo 尚未启用。");
      }
      return {
        state: { schemaVersion: 1, revision: 1, updatedAt: "2026-08-27T09:00:00+08:00", items: [] },
        revision: 1,
        pageUrl: "https://dailynews.test/todo/",
      };
    },
    async getThemeContext() {
      calls.push(["getThemeContext"]);
      return {
        themeSchema: {
          schemaVersion: 1,
          idPattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          name: { minimumVisibleCharacters: 1, maximumVisibleCharacters: 40 },
          colors: { format: "#RRGGBB", minimumTextContrast: 4.5 },
          enums: { density: ["compact", "balanced", "spacious"] },
          forbidden: ["html", "css", "javascript"],
        },
        constraints: {
          customThemeLimit: 24,
          customThemeCount: 1,
          officialThemesReadOnly: true,
          selectionManagedInBrowser: true,
          baseRevisionRequiredForUpdateAndDelete: true,
        },
        themes: [{
          themeId: "example-theme", name: "示例主题", source: "custom", revision: 1,
          usage: { home: false, publications: [] },
        }],
      };
    },
    async getTheme(_access, themeId) {
      calls.push(["getTheme", themeId]);
      return {
        themeId, name: "示例主题", source: "custom", revision: 1,
        definition: { schemaVersion: 1, id: themeId },
        usage: { home: false, publications: [] },
      };
    },
    async createTheme(_access, input) {
      calls.push(["createTheme", input]);
      return { result: "created", themeId: input.theme.id, revision: 1, affected: { home: false, publications: [] } };
    },
    async updateTheme(_access, input) {
      calls.push(["updateTheme", input]);
      return { result: "updated", themeId: input.themeId, revision: 2, affected: { home: false, publications: [] } };
    },
    async deleteTheme(_access, input) {
      calls.push(["deleteTheme", input]);
      return { result: "deleted", themeId: input.themeId, revision: input.baseRevision, affected: { home: false, publications: [] } };
    },
  };
  const app = createCloudApp({
    basePath: "/cloud",
    readinessCheck: async () => {},
    clientIpResolver: () => "203.0.113.20",
    agentMcp: {
      origin,
      authenticator,
      operations,
      requestBodyLimitBytes: options.requestBodyLimitBytes ?? 262144,
      dailyItemLimit: 100,
      todoOperationLimit: 100,
      ...(options.useNodeOriginResolver
        ? {}
        : { requestOriginResolver: options.requestOriginResolver ?? (() => origin) }),
    },
  });
  return { app, authentications, calls };
}

function mcpClientFor(app, era, exchanges = []) {
  const client = new Client({ name: `dailynews-${era}-test`, version: "1.0.0" }, era === "modern"
    ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    : undefined);
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.clone().text() : "";
    const response = await app.request(request);
    exchanges.push({ request, body, response: response.clone() });
    return response;
  };
  const transport = new StreamableHTTPClientTransport(new URL("https://dailynews.test/cloud/mcp"), {
    requestInit: { headers: { authorization: "Bearer valid-token" } },
    fetch,
  });
  return { client, transport };
}

const dailyCandidate = {
  schemaVersion: 2,
  date: "2026-08-27",
  generatedAt: "2026-08-27T09:00:00+08:00",
  coverage: { start: "2026-08-26T09:00:00+08:00", end: "2026-08-27T09:00:00+08:00" },
  items: [{
    id: "example-story",
    title: "虚构标题",
    brief: "虚构摘要",
    summary: "只用于 MCP 契约测试的虚构正文。",
    editorial: { priority: "normal", selectionReason: "验证工具 Schema" },
    sources: [{ name: "Example", url: "https://example.com/fake-story" }],
  }],
};

const todoCandidate = {
  schemaVersion: 1,
  candidateId: "example-todo-run",
  generatedAt: "2026-08-27T09:00:00+08:00",
  baseRevision: 0,
  operations: [{ type: "add", clientId: "draft-one", title: "提交示例周报" }],
};

const customTheme = {
  schemaVersion: 1,
  id: "example-theme",
  name: "示例主题",
  extends: "newspaper-default",
  tokens: { colors: { accent: "#2457A7" } },
  recipes: { normal: "accent" },
};

for (const era of ["legacy", "modern"]) {
  test(`official MCP ${era} client discovers the same eleven tools and completes every operation`, async () => {
    const { app, authentications, calls } = agentMcpTestApp();
    const exchanges = [];
    const { client, transport } = mcpClientFor(app, era, exchanges);
    await client.connect(transport);
    try {
      assert.equal(client.getServerVersion().name, "dailynews");
      assert.equal(client.getInstructions(), DAILYNEWS_MCP_INSTRUCTIONS);
      assert.ok(client.getInstructions().length <= 512);
      for (const rule of [
        /context before every write/, /Daily defaults/, /explicit publicationId and date/,
        /Do not mix Daily and Todo Candidates/, /set Space or formal state/,
        /Disabled Todo/, /reuse clientRunId/, /Historical and replace writes/, /no HTML, CSS, JavaScript/,
      ]) assert.match(client.getInstructions(), rule);
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(({ name }) => name), [
        "get_daily_context",
        "submit_daily_candidate",
        "get_daily_issue",
        "get_todo_context",
        "submit_todo_candidate",
        "get_todo_state",
        "get_theme_context",
        "get_theme",
        "create_theme",
        "update_theme",
        "delete_theme",
      ]);
      for (const tool of listed.tools) {
        assert.equal(tool.annotations.openWorldHint, false);
        assert.ok(tool.inputSchema);
        assert.ok(tool.outputSchema);
      }
      assert.equal(listed.tools.find(({ name }) => name === "get_daily_context").annotations.readOnlyHint, true);
      const dailySubmitTool = listed.tools.find(({ name }) => name === "submit_daily_candidate");
      const todoSubmitTool = listed.tools.find(({ name }) => name === "submit_todo_candidate");
      assert.equal(dailySubmitTool.annotations.destructiveHint, true);
      assert.equal(dailySubmitTool.inputSchema.properties.candidate.properties.items.maxItems, 100);
      assert.equal(todoSubmitTool.inputSchema.properties.candidate.properties.operations.maxItems, 100);
      assert.equal(listed.tools.find(({ name }) => name === "delete_theme").annotations.destructiveHint, true);

      const context = await client.callTool({ name: "get_daily_context", arguments: {} });
      assert.equal(context.structuredContent.publication.publicationId, "daily-news");
      assert.equal(context.structuredContent.availablePublications.length, 1);
      await client.callTool({
        name: "submit_daily_candidate",
        arguments: {
          publicationId: "daily-news",
          clientRunId: "daily-mcp-run-0001",
          mode: "update",
          confirmation: { historicalDate: null, replace: null },
          candidate: dailyCandidate,
        },
      });
      await client.callTool({
        name: "get_daily_issue",
        arguments: { publicationId: "daily-news", date: "2026-08-27" },
      });
      await client.callTool({ name: "get_todo_context", arguments: {} });
      await client.callTool({
        name: "submit_todo_candidate",
        arguments: { clientRunId: "todo-mcp-run-0001", candidate: todoCandidate },
      });
      await client.callTool({ name: "get_todo_state", arguments: {} });
      await client.callTool({ name: "get_theme_context", arguments: {} });
      await client.callTool({ name: "get_theme", arguments: { themeId: "example-theme" } });
      await client.callTool({
        name: "create_theme",
        arguments: { clientRunId: "theme-create-0001", theme: customTheme },
      });
      await client.callTool({
        name: "update_theme",
        arguments: { themeId: "example-theme", clientRunId: "theme-update-0001", baseRevision: 1, theme: customTheme },
      });
      await client.callTool({
        name: "delete_theme",
        arguments: { themeId: "example-theme", clientRunId: "theme-delete-0001", baseRevision: 2 },
      });

      assert.ok(calls.some(([name]) => name === "submitDailyCandidate"));
      assert.ok(calls.some(([name]) => name === "submitTodoCandidate"));
      assert.ok(calls.some(([name]) => name === "createTheme"));
      assert.ok(calls.some(([name]) => name === "updateTheme"));
      assert.ok(calls.some(([name]) => name === "deleteTheme"));
      assert.ok(authentications.some(({ action }) => action === "read"));
      assert.ok(authentications.some(({ action }) => action === "write"));
      assert.ok(exchanges.every(({ response }) => response.headers.get("cache-control") === "private, no-store"));
      assert.ok(exchanges.every(({ response }) => /^req_[0-9a-f]{32}$/.test(response.headers.get("x-request-id"))));
      assert.ok(exchanges.every(({ response }) => response.headers.get("mcp-session-id") === null));
      assert.ok(exchanges.every(({ response }) => response.headers.get("access-control-allow-origin") === null));
      if (era === "modern") {
        const modernCalls = exchanges.filter(({ body }) => body.includes('"method":"tools/call"'));
        assert.ok(modernCalls.length >= 11);
        assert.ok(modernCalls.every(({ request }) => request.headers.get("mcp-protocol-version") === "2026-07-28"));
        assert.ok(modernCalls.every(({ request }) => request.headers.get("mcp-method") === "tools/call"));
        assert.ok(modernCalls.every(({ request }) => request.headers.get("mcp-name")));
      }
    } finally {
      await client.close();
    }
  });
}

test("MCP route fails closed for method, Origin, PAT, media type, and body limits", async () => {
  const { app, authentications } = agentMcpTestApp({ requestBodyLimitBytes: 128 });
  const url = "https://dailynews.test/cloud/mcp";
  const get = await app.request(url);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");

  const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const crossOrigin = await app.request(url, {
    method: "POST",
    headers: { authorization: "Bearer valid-token", origin: "https://attacker.test", "content-type": "application/json" },
    body: message,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(authentications.length, 0);

  const cookieOnly = await app.request(url, {
    method: "POST",
    headers: { cookie: "session=fake", "content-type": "application/json" },
    body: message,
  });
  assert.equal(cookieOnly.status, 401);
  assert.equal(cookieOnly.headers.get("www-authenticate"), "Bearer");
  assert.equal((await cookieOnly.json()).error.code, "invalid_token");

  const wrongMedia = await app.request(url, {
    method: "POST",
    headers: { authorization: "Bearer valid-token", "content-type": "text/plain" },
    body: message,
  });
  assert.equal(wrongMedia.status, 415);

  const oversized = await app.request(url, {
    method: "POST",
    headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { padding: "x".repeat(200) } }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "payload_too_large");
});

test("MCP rejects non-loopback clients for a loopback HTTP origin before PAT authentication", async () => {
  const origin = "http://127.0.0.1:3000";
  const { app, authentications } = agentMcpTestApp({
    origin,
    requestOriginResolver: (context) => resolveTrustedExternalOrigin({
      requestUrl: context.req.url,
      requestHost: context.req.header("host"),
      transportProtocol: "http",
      configuredOrigin: origin,
      remoteAddress: "203.0.113.20",
      forwardedProto: context.req.header("x-forwarded-proto"),
    }),
  });
  const response = await app.request(`${origin}/cloud/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 403);
  assert.equal(authentications.length, 0);
});

test("MCP tool failures remain structured, redacted, and correlated", async () => {
  const { app } = agentMcpTestApp({ todoDisabled: true });
  const { client, transport } = mcpClientFor(app, "modern");
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "get_todo_state", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "todo_disabled");
    assert.match(result.structuredContent.error.requestId, /^req_[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(result), /valid-token|credential-one|space-one/);
  } finally {
    await client.close();
  }
});

test("modern MCP rejects protocol and operation header mismatches", async () => {
  const { app } = agentMcpTestApp();
  const url = "https://dailynews.test/cloud/mcp";
  const message = (method, params = {}) => JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "raw-modern-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  const headers = {
    authorization: "Bearer valid-token",
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/list",
  };
  const valid = await app.request(url, { method: "POST", headers, body: message("tools/list") });
  assert.equal(valid.status, 200);
  assert.ok((await valid.json()).result.tools);

  for (const changedHeaders of [
    { "mcp-protocol-version": undefined },
    { "mcp-protocol-version": "2026-07-29" },
    { "mcp-method": undefined },
    { "mcp-method": "tools/call" },
  ]) {
    const requestHeaders = new Headers(headers);
    for (const [name, value] of Object.entries(changedHeaders)) {
      if (value === undefined) requestHeaders.delete(name);
      else requestHeaders.set(name, value);
    }
    const response = await app.request(url, { method: "POST", headers: requestHeaders, body: message("tools/list") });
    const payload = await response.json();
    assert.ok(response.status >= 400 || payload.error, JSON.stringify({ changedHeaders, status: response.status, payload }));
  }

  const callHeaders = { ...headers, "mcp-method": "tools/call" };
  for (const name of [undefined, "get_todo_state"]) {
    const requestHeaders = new Headers(callHeaders);
    if (name) requestHeaders.set("mcp-name", name);
    const response = await app.request(url, {
      method: "POST",
      headers: requestHeaders,
      body: message("tools/call", { name: "get_daily_context", arguments: {} }),
    });
    const payload = await response.json();
    assert.ok(response.status >= 400 || payload.error, JSON.stringify({ name, status: response.status, payload }));
  }
});

test("legacy MCP batches containing any submission consume the write quota", async () => {
  const { app, authentications } = agentMcpTestApp();
  await app.request("https://dailynews.test/cloud/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_todo_candidate", arguments: {} } },
    ]),
  });
  assert.equal(authentications.at(-1).action, "write");
});

test("real HTTP adapter accepts only the trusted loopback TLS terminator for MCP", async () => {
  const { app } = agentMcpTestApp({ useNodeOriginResolver: true });
  const server = createAdaptorServer({ fetch: app.fetch, hostname: "127.0.0.1" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const request = (headers = {}, requestTarget = "/cloud/mcp") => new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path: requestTarget,
      method: "POST",
      headers: {
        host: "dailynews.test",
        authorization: "Bearer valid-token",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...headers,
      },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.once("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
  try {
    assert.equal((await app.request("https://dailynews.test/cloud/mcp", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      body,
    })).status, 403);
    assert.equal((await request()).status, 403);
    assert.equal((await request({ "x-forwarded-proto": "http" })).status, 403);
    assert.equal((await request({ "x-forwarded-proto": "https", origin: "https://attacker.test" })).status, 403);
    assert.equal((await request(
      { "x-forwarded-proto": "https", host: "attacker.test" },
      "https://dailynews.test/cloud/mcp",
    )).status, 403);
    const accepted = await request({ "x-forwarded-proto": "https", origin: "https://dailynews.test" });
    assert.equal(accepted.status, 200);
    assert.match(accepted.body, /get_daily_context/);
    assert.equal(accepted.headers["mcp-session-id"], undefined);
  } finally {
    await closeHttpServer(server);
  }
});
