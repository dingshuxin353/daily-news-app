import { randomUUID } from "node:crypto";
import { type Context, type Hono } from "hono";
import type { CloudFileConfig } from "../cloud/config.js";
import type { PostgresTenancyStore, TenantContext } from "../adapters/postgres/tenancy.js";
import type { IdentityService } from "../modules/identity/auth.js";
import {
  AgentAccessError,
  type AgentCredentialService,
  type CredentialRecord,
  type PairingRecord,
} from "../modules/agent-access/credential-service.js";
import { assertBrowserMutation, createSettingsCsrfToken, readSettingsBody } from "./settings-security.js";

export interface AgentSettingsDependencies {
  basePath: string;
  origin: string;
  csrfSecret: string;
  identity: IdentityService;
  tenancy: PostgresTenancyStore;
  defaults: CloudFileConfig["defaults"];
  agentAccess: AgentCredentialService;
  clientIpResolver: (context: Context) => string;
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

  async function browserAccess(context: Context, currentRequestId: string): Promise<BrowserAccessContext> {
    const session = await dependencies.identity.getSession(context.req.raw, dependencies.clientIpResolver(context));
    if (!session) throw new AgentAccessError(401, "authentication_failed", "请先登录后再继续。");
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
    return context.json({
      csrfToken: access.csrfToken,
      newConnectionOperationId: randomUUID(),
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
    return context.json({ pairing: pairingSummary(pairing), requestId: currentRequestId });
  }));

  app.get(route("/settings/agent/connections/:id/remove"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const credential = (await dependencies.agentAccess.listCredentials(access.tenant))
      .find(({ id, status }) => id === context.req.param("id") && status === "active");
    if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可移除的 Agent 授权。");
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

  app.get(route("/settings/agent/manual-tokens"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const credentials = await dependencies.agentAccess.listCredentials(access.tenant);
    return context.json({
      csrfToken: access.csrfToken,
      operationId: randomUUID(),
      apiBaseUrl: dependencies.apiBaseUrl,
      mcpUrl: dependencies.mcpUrl,
      credentials: credentials.map((item) => credentialSummary(item, true)),
      requestId: currentRequestId,
    });
  }));

  app.post(route("/settings/agent/manual-tokens"), (context) => run(context, async (currentRequestId) => {
    const { access, body } = await browserMutation(context, currentRequestId);
    const result = await dependencies.agentAccess.issueManualCredential(
      access.tenant,
      { name: body.name, operationId: body.operationId },
      currentRequestId,
      access.actorDigest,
    );
    return context.json({
      credential: credentialSummary(result.credential, true),
      token: result.token,
      repeated: result.repeated,
      requestId: currentRequestId,
    }, result.repeated ? 200 : 201);
  }));

  app.get(route("/settings/agent/manual-tokens/:id/rotate"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const credential = (await dependencies.agentAccess.listCredentials(access.tenant))
      .find(({ id, status }) => id === context.req.param("id") && status === "active");
    if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可轮换的连接密钥。");
    return context.json({
      credential: credentialSummary(credential, true),
      operationId: randomUUID(),
      csrfToken: access.csrfToken,
      requestId: currentRequestId,
    });
  }));

  app.post(route("/settings/agent/manual-tokens/:id/rotate"), (context) => run(context, async (currentRequestId) => {
    const { access, body } = await browserMutation(context, currentRequestId);
    const result = await dependencies.agentAccess.rotateCredential(
      access.tenant,
      context.req.param("id"),
      { name: body.name, operationId: body.operationId },
      currentRequestId,
      access.actorDigest,
    );
    return context.json({
      credential: credentialSummary(result.credential, true),
      token: result.token,
      repeated: result.repeated,
      requestId: currentRequestId,
    }, result.repeated ? 200 : 201);
  }));

  app.get(route("/settings/agent/manual-tokens/:id/revoke"), (context) => run(context, async (currentRequestId) => {
    const access = await browserAccess(context, currentRequestId);
    const credential = (await dependencies.agentAccess.listCredentials(access.tenant))
      .find(({ id, status }) => id === context.req.param("id") && status === "active");
    if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可撤销的连接密钥。");
    return context.json({ credential: credentialSummary(credential, true), csrfToken: access.csrfToken, requestId: currentRequestId });
  }));

  app.post(route("/settings/agent/manual-tokens/:id/revoke"), (context) => run(context, async (currentRequestId) => {
    const { access } = await browserMutation(context, currentRequestId);
    const credential = await dependencies.agentAccess.revokeCredential(
      access.tenant,
      context.req.param("id"),
      currentRequestId,
      access.actorDigest,
    );
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
    await readSettingsBody(context.req.raw, dependencies.requestBodyLimitBytes);
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
