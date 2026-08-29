import { randomUUID } from "node:crypto";
import { type Context, type Hono } from "hono";
import type { CloudFileConfig } from "../cloud/config.js";
import type { PostgresTenancyStore, TenantContext } from "../adapters/postgres/tenancy.js";
import type { PrivateReadingService } from "../modules/private-reading/service.js";
import type { IdentityService } from "../modules/identity/auth.js";
import type { UserProfileService } from "../modules/identity/profile-service.js";
import {
  AgentAccessError,
  type AgentCredentialService,
  type CredentialRecord,
  type PairingRecord,
} from "../modules/agent-access/credential-service.js";
import { assertBrowserMutation, createSettingsCsrfToken, readSettingsBody } from "./settings-security.js";
import {
  renderAdvancedAccessPage,
  renderAgentSettingsPage,
  renderConfirmPage,
  renderCredentialSecretPage,
  renderOnboardingPage,
} from "./private-pages.js";

export interface AgentSettingsDependencies {
  basePath: string;
  origin: string;
  csrfSecret: string;
  identity: IdentityService;
  profiles?: UserProfileService;
  tenancy: PostgresTenancyStore;
  privateReading?: PrivateReadingService;
  defaults: CloudFileConfig["defaults"];
  agentAccess: AgentCredentialService;
  clientIpResolver: (context: Context) => string;
  requestOriginResolver: (context: Context) => string | null;
  digestActor: (purpose: "session" | "ip", value: string) => string;
  apiBaseUrl: string;
  mcpUrl: string;
  activeCredentialLimit: number;
  requestBodyLimitBytes: number;
}

interface BrowserAccessContext {
  tenant: TenantContext;
  sessionId: string;
  userId: string;
  csrfToken: string;
  actorDigest: string;
}

function requestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

function credentialSummary(record: CredentialRecord, advanced = false) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    ...(advanced ? { tokenHint: record.tokenHint, rotatedFromId: record.rotatedFromId, revokedAt: record.revokedAt } : {}),
  };
}

function pairingSummary(record: PairingRecord & { code?: string | null }) {
  return {
    id: record.id,
    name: record.intendedName,
    purpose: record.purpose,
    status: record.status,
    code: record.code ?? null,
    expiresAt: record.expiresAt,
    claimStartedAt: record.claimStartedAt,
    verifiedAt: record.verifiedAt,
    createdAt: record.createdAt,
  };
}

function responseError(context: Context, error: unknown, currentRequestId: string): Response {
  const safe = error instanceof AgentAccessError
    ? error
    : new AgentAccessError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
  if (safe.status === 401 && context.req.method === "GET" && context.req.header("accept")?.includes("text/html")) {
    const settingsIndex = context.req.path.indexOf("/settings/");
    const basePath = settingsIndex >= 0 ? context.req.path.slice(0, settingsIndex) : "";
    const target = `${context.req.path}${new URL(context.req.url).search}`;
    return context.redirect(`${basePath}/login?returnTo=${encodeURIComponent(target)}`, 303);
  }
  if (safe.code === "profile_incomplete" && context.req.method === "GET" && context.req.header("accept")?.includes("text/html")) {
    const settingsIndex = context.req.path.indexOf("/settings/");
    const basePath = settingsIndex >= 0 ? context.req.path.slice(0, settingsIndex) : "";
    return context.redirect(`${basePath}/onboarding`, 303);
  }
  if (safe.status === 401 && context.req.path.endsWith("/agent-pairing/v1/verify")) {
    context.header("WWW-Authenticate", "Bearer");
  }
  if (safe.status === 429 && safe.retryAfterSeconds) {
    context.header("Retry-After", String(safe.retryAfterSeconds));
  }
  return context.json({
    error: { code: safe.code, message: safe.message, requestId: currentRequestId },
  }, safe.status);
}

async function run(
  context: Context,
  callback: (currentRequestId: string) => Promise<Response>,
): Promise<Response> {
  const currentRequestId = requestId();
  context.header("X-Request-Id", currentRequestId);
  try {
    return await callback(currentRequestId);
  } catch (error) {
    return responseError(context, error, currentRequestId);
  }
}

export function registerAgentSettingsRoutes(app: Hono, dependencies: AgentSettingsDependencies): void {
  const route = (pathname: string) => `${dependencies.basePath}${pathname}`;
  const wantsHtml = (context: Context) => context.req.header("accept")?.includes("text/html") === true;
  const setupUrl = `${dependencies.origin}${route("/.well-known/dailynews-agent-setup.json")}`;

  async function browserAccess(context: Context, currentRequestId: string): Promise<BrowserAccessContext> {
    const session = await dependencies.identity.getSession(context.req.raw, dependencies.clientIpResolver(context));
    if (!session) throw new AgentAccessError(401, "authentication_failed", "请先登录后再继续。");
    if (dependencies.profiles && !(await dependencies.profiles.read(session.user.id))?.complete) {
      throw new AgentAccessError(409, "profile_incomplete", "请先填写昵称后再连接 Agent。");
    }
    const tenant = await dependencies.tenancy.ensureSpaceForUser(session.user.id, dependencies.defaults);
    const actorDigest = dependencies.digestActor("session", `${session.session.id}:${session.user.id}`);
    await dependencies.agentAccess.ensureBootstrapPairing(tenant, currentRequestId, actorDigest);
    return {
      tenant,
      sessionId: session.session.id,
      userId: session.user.id,
      csrfToken: createSettingsCsrfToken(
        dependencies.csrfSecret,
        session.session.id,
        session.user.id,
      ),
      actorDigest,
    };
  }

  async function browserMutation(context: Context, currentRequestId: string) {
    const access = await browserAccess(context, currentRequestId);
    const body = await readSettingsBody(context.req.raw, dependencies.requestBodyLimitBytes);
    assertBrowserMutation({
      request: context.req.raw,
      requestOrigin: dependencies.requestOriginResolver(context),
      configuredOrigin: dependencies.origin,
      csrfSecret: dependencies.csrfSecret,
      sessionId: access.sessionId,
      userId: access.userId,
      body,
    });
    return { access, body };
  }

  app.get(route("/settings/agent"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const [credentials, pairings] = await Promise.all([
      dependencies.agentAccess.listCredentials(access.tenant),
      dependencies.agentAccess.listPairings(access.tenant, currentRequestId, access.actorDigest),
    ]);
    const newConnectionOperationId = randomUUID();
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderAgentSettingsPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        credentials,
        pairings,
        csrfToken: access.csrfToken,
        operationId: newConnectionOperationId,
        activeLimit: dependencies.activeCredentialLimit,
      }));
    }
    return context.json({
      csrfToken: access.csrfToken,
      newConnectionOperationId,
      newManualTokenOperationId: randomUUID(),
      activeLimit: dependencies.activeCredentialLimit,
      authorizations: credentials.filter(({ status }) => status === "active").map((item) => credentialSummary(item)),
      pairings: pairings.filter(({ status }) => status !== "verified").map(pairingSummary),
      requestId: currentRequestId,
    });
  }));

  app.post(route("/settings/agent/connections"), (context) => run(context, async (currentRequestId) => {
    const { access, body } = await browserMutation(context, currentRequestId);
    const pairing = await dependencies.agentAccess.createPairing(
      access.tenant,
      { name: body.name, operationId: body.operationId },
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context)) return context.redirect(route(`/settings/agent/connections/${pairing.id}/pair`), 303);
    return context.json({ pairing: pairingSummary(pairing), requestId: currentRequestId }, pairing.repeated ? 200 : 201);
  }));

  app.get(route("/settings/agent/connections/:id/pair"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const pairing = await dependencies.agentAccess.getPairing(
      access.tenant,
      context.req.param("id"),
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderOnboardingPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        pairing,
        csrfToken: access.csrfToken,
        setupUrl,
        firstUse: false,
        refreshed: context.req.query("refreshed") === "1",
      }));
    }
    return context.json({ pairing: pairingSummary(pairing), csrfToken: access.csrfToken, requestId: currentRequestId });
  }));

  app.post(route("/settings/agent/connections/:id/pair/refresh"), (context) => run(context, async (currentRequestId) => {
    const { access } = await browserMutation(context, currentRequestId);
    const pairing = await dependencies.agentAccess.refreshPairing(
      access.tenant,
      context.req.param("id"),
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context)) return context.redirect(`${route(`/settings/agent/connections/${pairing.id}/pair`)}?refreshed=1#pairing-title`, 303);
    return context.json({ pairing: pairingSummary(pairing), requestId: currentRequestId });
  }));

  app.post(route("/settings/agent/connections/:id/pair/cancel"), (context) => run(context, async (currentRequestId) => {
    const { access } = await browserMutation(context, currentRequestId);
    const pairing = await dependencies.agentAccess.cancelClaimAndRefresh(
      access.tenant,
      context.req.param("id"),
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context)) return context.redirect(`${route(`/settings/agent/connections/${pairing.id}/pair`)}?refreshed=1#pairing-title`, 303);
    return context.json({ pairing: pairingSummary(pairing), requestId: currentRequestId });
  }));

  app.get(route("/settings/agent/connections/:id/remove"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const credential = (await dependencies.agentAccess.listCredentials(access.tenant))
      .find(({ id, status }) => id === context.req.param("id") && status === "active");
    if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可移除的 Agent 授权。");
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderConfirmPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        title: `移除 ${credential.name}？`,
        description: "这个 Agent 的访问权会立即撤销；已经提交的日报和 Todo 会保留，其他 Agent 不受影响。",
        action: route(`/settings/agent/connections/${credential.id}/remove`),
        csrfToken: access.csrfToken,
        submitLabel: "移除 Agent",
      }));
    }
    return context.json({ credential: credentialSummary(credential), csrfToken: access.csrfToken, requestId: currentRequestId });
  }));

  app.post(route("/settings/agent/connections/:id/remove"), (context) => run(context, async (currentRequestId) => {
    const { access } = await browserMutation(context, currentRequestId);
    const credential = await dependencies.agentAccess.revokeCredential(
      access.tenant,
      context.req.param("id"),
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context)) return context.redirect(route("/settings/agent"), 303);
    return context.json({ credential: credentialSummary(credential), requestId: currentRequestId });
  }));

  app.post(route("/settings/agent/connections/:id/name"), (context) => run(context, async (currentRequestId) => {
    const { access, body } = await browserMutation(context, currentRequestId);
    const credential = await dependencies.agentAccess.renameCredential(
      access.tenant,
      context.req.param("id"),
      body.name,
      currentRequestId,
      access.actorDigest,
    );
    return context.json({ credential: credentialSummary(credential), requestId: currentRequestId });
  }));

  app.get(route("/settings/advanced"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const credentials = await dependencies.agentAccess.listCredentials(access.tenant);
    const operationId = randomUUID();
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderAdvancedAccessPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        credentials,
        csrfToken: access.csrfToken,
        operationId,
        apiBaseUrl: dependencies.apiBaseUrl,
        mcpUrl: dependencies.mcpUrl,
      }));
    }
    return context.json({
      csrfToken: access.csrfToken,
      operationId,
      apiBaseUrl: dependencies.apiBaseUrl,
      mcpUrl: dependencies.mcpUrl,
      credentials: credentials.map((item) => credentialSummary(item, true)),
      requestId: currentRequestId,
    });
  }));

  app.post(route("/settings/advanced/tokens"), (context) => run(context, async (currentRequestId) => {
    const { access, body } = await browserMutation(context, currentRequestId);
    const result = await dependencies.agentAccess.issueManualCredential(
      access.tenant,
      { name: body.name, operationId: body.operationId },
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderCredentialSecretPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        token: result.token,
        title: "个人访问令牌已创建",
      }), result.repeated ? 200 : 201);
    }
    return context.json({
      credential: credentialSummary(result.credential, true),
      token: result.token,
      repeated: result.repeated,
      requestId: currentRequestId,
    }, result.repeated ? 200 : 201);
  }));

  app.get(route("/settings/advanced/tokens/:id/rotate"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const credential = (await dependencies.agentAccess.listCredentials(access.tenant))
      .find(({ id, status }) => id === context.req.param("id") && status === "active");
    if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可轮换的连接密钥。");
    const operationId = randomUUID();
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderConfirmPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        title: `轮换 ${credential.name}？`,
        description: "旧令牌会立即失效，新令牌只显示一次。请先确认客户端能够安全保存新凭证。",
        action: route(`/settings/advanced/tokens/${credential.id}/rotate`),
        cancelPath: "/settings/advanced",
        csrfToken: access.csrfToken,
        submitLabel: "轮换并显示新令牌",
        hidden: { name: credential.name, operationId },
      }));
    }
    return context.json({
      credential: credentialSummary(credential, true),
      operationId,
      csrfToken: access.csrfToken,
      requestId: currentRequestId,
    });
  }));

  app.post(route("/settings/advanced/tokens/:id/rotate"), (context) => run(context, async (currentRequestId) => {
    const { access, body } = await browserMutation(context, currentRequestId);
    const result = await dependencies.agentAccess.rotateCredential(
      access.tenant,
      context.req.param("id"),
      { name: body.name, operationId: body.operationId },
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderCredentialSecretPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        token: result.token,
        title: "个人访问令牌已轮换",
      }));
    }
    return context.json({
      credential: credentialSummary(result.credential, true),
      token: result.token,
      repeated: result.repeated,
      requestId: currentRequestId,
    }, result.repeated ? 200 : 201);
  }));

  app.get(route("/settings/advanced/tokens/:id/revoke"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const credential = (await dependencies.agentAccess.listCredentials(access.tenant))
      .find(({ id, status }) => id === context.req.param("id") && status === "active");
    if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可撤销的连接密钥。");
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderConfirmPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        title: `撤销 ${credential.name}？`,
        description: "这个令牌会立即失效；它已经提交的正式内容不会删除。",
        action: route(`/settings/advanced/tokens/${credential.id}/revoke`),
        cancelPath: "/settings/advanced",
        csrfToken: access.csrfToken,
        submitLabel: "撤销令牌",
      }));
    }
    return context.json({ credential: credentialSummary(credential, true), csrfToken: access.csrfToken, requestId: currentRequestId });
  }));

  app.post(route("/settings/advanced/tokens/:id/revoke"), (context) => run(context, async (currentRequestId) => {
    const { access } = await browserMutation(context, currentRequestId);
    const credential = await dependencies.agentAccess.revokeCredential(
      access.tenant,
      context.req.param("id"),
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context)) return context.redirect(route("/settings/advanced"), 303);
    return context.json({ credential: credentialSummary(credential, true), requestId: currentRequestId });
  }));

  app.post(route("/agent-pairing/v1/claim"), (context) => run(context, async (currentRequestId) => {
    const body = await readSettingsBody(context.req.raw, dependencies.requestBodyLimitBytes);
    const ipDigest = dependencies.digestActor("ip", dependencies.clientIpResolver(context));
    const result = await dependencies.agentAccess.claimPairing({
      code: body.pairingCode,
      clientName: body.clientName,
      ipDigest,
      requestId: currentRequestId,
    });
    return context.json({ ...result, requestId: currentRequestId }, 201);
  }));

  app.post(route("/agent-pairing/v1/verify"), (context) => run(context, async (currentRequestId) => {
    const ipDigest = dependencies.digestActor("ip", dependencies.clientIpResolver(context));
    const result = await dependencies.agentAccess.verifyPairing({
      authorization: context.req.header("authorization"),
      ipDigest,
      requestId: currentRequestId,
    });
    return context.json({
      status: "active",
      credential: credentialSummary(result.credential),
      context: result.context,
      requestId: currentRequestId,
    });
  }));
}
