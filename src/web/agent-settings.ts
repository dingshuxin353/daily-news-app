import { randomUUID } from "node:crypto";
import { type Context, type Hono } from "hono";
import type { CloudFileConfig } from "../cloud/config.js";
import type { PostgresTenancyStore, TenantContext } from "../adapters/postgres/tenancy.js";
import type { PrivateReadingService } from "../modules/private-reading/service.js";
import type { IdentityService } from "../modules/identity/auth.js";
import type { UserProfileService } from "../modules/identity/profile-service.js";
import { AgentAccessError, type AgentCredentialService, type CredentialRecord } from "../modules/agent-access/credential-service.js";
import { assertBrowserMutation, createSettingsCsrfToken, readSettingsBody } from "./settings-security.js";
import {
  renderAdvancedAccessPage,
  renderAgentSettingsPage,
  renderConfirmPage,
  renderCredentialSecretPage,
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

function credentialSummary(record: CredentialRecord) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    tokenHint: record.tokenHint,
    rotatedFromId: record.rotatedFromId,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
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
  if (safe.status === 429 && safe.retryAfterSeconds) context.header("Retry-After", String(safe.retryAfterSeconds));
  return context.json({ error: { code: safe.code, message: safe.message, requestId: currentRequestId } }, safe.status);
}

async function run(context: Context, callback: (currentRequestId: string) => Promise<Response>): Promise<Response> {
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

  async function browserAccess(context: Context): Promise<BrowserAccessContext> {
    const session = await dependencies.identity.getSession(context.req.raw, dependencies.clientIpResolver(context));
    if (!session) throw new AgentAccessError(401, "authentication_failed", "请先登录后再继续。");
    if (dependencies.profiles && !(await dependencies.profiles.read(session.user.id))?.complete) {
      throw new AgentAccessError(409, "profile_incomplete", "请先填写昵称后再创建 Agent Token。");
    }
    const tenant = await dependencies.tenancy.ensureSpaceForUser(session.user.id, dependencies.defaults);
    return {
      tenant,
      sessionId: session.session.id,
      userId: session.user.id,
      csrfToken: createSettingsCsrfToken(dependencies.csrfSecret, session.session.id, session.user.id),
      actorDigest: dependencies.digestActor("session", `${session.session.id}:${session.user.id}`),
    };
  }

  async function browserMutation(context: Context) {
    const access = await browserAccess(context);
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
    const access = await browserAccess(context);
    const credentials = await dependencies.agentAccess.listCredentials(access.tenant);
    const operationId = randomUUID();
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderAgentSettingsPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        credentials,
        csrfToken: access.csrfToken,
        operationId,
        activeLimit: dependencies.activeCredentialLimit,
      }));
    }
    return context.json({
      csrfToken: access.csrfToken,
      operationId,
      activeLimit: dependencies.activeCredentialLimit,
      credentials: credentials.map(credentialSummary),
      requestId: currentRequestId,
    });
  }));

  const createToken = (returnPath: "/onboarding" | "/settings/agent") =>
    (context: Context) => run(context, async (currentRequestId) => {
      const { access, body } = await browserMutation(context);
      const result = await dependencies.agentAccess.issueCredential(
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
          title: "Agent Token 已创建",
          returnPath,
        }), result.repeated ? 200 : 201);
      }
      return context.json({
        credential: credentialSummary(result.credential),
        token: result.token,
        repeated: result.repeated,
        requestId: currentRequestId,
      }, result.repeated ? 200 : 201);
    });

  app.post(route("/onboarding/token"), createToken("/onboarding"));
  app.post(route("/settings/agent/tokens"), createToken("/settings/agent"));

  app.get(route("/settings/agent/tokens/:id/rotate"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context);
    const credential = (await dependencies.agentAccess.listCredentials(access.tenant))
      .find(({ id, status }) => id === context.req.param("id") && status === "active");
    if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可轮换的 Agent Token。");
    const operationId = randomUUID();
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderConfirmPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        title: `轮换 ${credential.name}？`,
        description: "旧 Token 会立即失效，新 Token 只显示一次。",
        action: route(`/settings/agent/tokens/${credential.id}/rotate`),
        csrfToken: access.csrfToken,
        submitLabel: "轮换并显示新 Token",
        hidden: { name: credential.name, operationId },
      }));
    }
    return context.json({ credential: credentialSummary(credential), operationId, csrfToken: access.csrfToken, requestId: currentRequestId });
  }));

  app.post(route("/settings/agent/tokens/:id/rotate"), (context) => run(context, async (currentRequestId) => {
    const { access, body } = await browserMutation(context);
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
        title: "Agent Token 已轮换",
      }), result.repeated ? 200 : 201);
    }
    return context.json({ credential: credentialSummary(result.credential), token: result.token, repeated: result.repeated, requestId: currentRequestId }, result.repeated ? 200 : 201);
  }));

  app.get(route("/settings/agent/tokens/:id/revoke"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context);
    const credential = (await dependencies.agentAccess.listCredentials(access.tenant))
      .find(({ id, status }) => id === context.req.param("id") && status === "active");
    if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可撤销的 Agent Token。");
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderConfirmPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        title: `撤销 ${credential.name}？`,
        description: "这个 Token 会立即失效；它已经提交的正式内容不会删除。",
        action: route(`/settings/agent/tokens/${credential.id}/revoke`),
        csrfToken: access.csrfToken,
        submitLabel: "撤销 Token",
      }));
    }
    return context.json({ credential: credentialSummary(credential), csrfToken: access.csrfToken, requestId: currentRequestId });
  }));

  app.post(route("/settings/agent/tokens/:id/revoke"), (context) => run(context, async (currentRequestId) => {
    const { access } = await browserMutation(context);
    const credential = await dependencies.agentAccess.revokeCredential(
      access.tenant,
      context.req.param("id"),
      currentRequestId,
      access.actorDigest,
    );
    if (wantsHtml(context)) return context.redirect(route("/settings/agent"), 303);
    return context.json({ credential: credentialSummary(credential), requestId: currentRequestId });
  }));

  app.post(route("/settings/agent/tokens/:id/name"), (context) => run(context, async (currentRequestId) => {
    const { access, body } = await browserMutation(context);
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
    const access = await browserAccess(context);
    if (wantsHtml(context) && dependencies.privateReading) {
      return context.html(renderAdvancedAccessPage({
        basePath: dependencies.basePath,
        shell: await dependencies.privateReading.readShell(access.tenant),
        apiBaseUrl: dependencies.apiBaseUrl,
        mcpUrl: dependencies.mcpUrl,
      }));
    }
    return context.json({ apiBaseUrl: dependencies.apiBaseUrl, mcpUrl: dependencies.mcpUrl, requestId: currentRequestId });
  }));
}
