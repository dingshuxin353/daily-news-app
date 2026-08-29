import { type Context, type Hono } from "hono";
import type { AgentRequestAuthenticator } from "../../cloud/agent-context.js";
import { createAgentRequestId } from "../../cloud/agent-context.js";
import { agentErrorResponse } from "../../cloud/error-response.js";
import type { AgentOperationsService, DailyConfirmationInput } from "../../modules/agent-access/operations.js";
import type { AgentRequestAction, AgentRequestContext } from "../../modules/agent-access/request-policy.js";
import { AgentRequestError } from "../../modules/agent-access/request-policy.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PUBLICATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const API_ROUTES = Object.freeze({
  publications: { method: "get", honoPath: "/publications", path: "/publications" },
  dailyContext: {
    method: "get",
    honoPath: "/publications/:publicationId/daily-context",
    path: "/publications/{publicationId}/daily-context",
  },
  dailyCandidates: {
    method: "post",
    honoPath: "/publications/:publicationId/daily-candidates",
    path: "/publications/{publicationId}/daily-candidates",
  },
  dailyIssue: {
    method: "get",
    honoPath: "/publications/:publicationId/issues/:date",
    path: "/publications/{publicationId}/issues/{date}",
  },
  todo: { method: "get", honoPath: "/todo", path: "/todo" },
  todoCandidates: { method: "post", honoPath: "/todo/candidates", path: "/todo/candidates" },
  themeContext: { method: "get", honoPath: "/themes/context", path: "/themes/context" },
  theme: { method: "get", honoPath: "/themes/:themeId", path: "/themes/{themeId}" },
  createTheme: { method: "post", honoPath: "/themes", path: "/themes" },
  updateTheme: { method: "put", honoPath: "/themes/:themeId", path: "/themes/{themeId}" },
  deleteTheme: { method: "delete", honoPath: "/themes/:themeId", path: "/themes/{themeId}" },
} as const);

export const AGENT_API_ROUTE_CONTRACT = Object.freeze(
  Object.values(API_ROUTES).map(({ method, path }) => ({ method, path })),
);

export interface AgentApiRouteDependencies {
  basePath: string;
  authenticator: AgentRequestAuthenticator;
  operations: AgentOperationsService;
  clientIpResolver: (context: Context) => string;
  requestBodyLimitBytes: number;
}

function requireExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new AgentRequestError(400, "invalid_request", "请求包含不支持的字段。");
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRequestError(400, "invalid_request", `${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function readJsonBody(request: Request, limit: number): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AgentRequestError(400, "invalid_request", "写入请求必须使用 application/json。");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    throw new AgentRequestError(413, "payload_too_large", "请求内容超过允许大小。");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new AgentRequestError(413, "payload_too_large", "请求内容超过允许大小。");
      }
      chunks.push(Buffer.from(value));
    }
  }
  try {
    return requireRecord(JSON.parse(Buffer.concat(chunks, total).toString("utf8")), "请求正文");
  } catch (error) {
    if (error instanceof AgentRequestError) throw error;
    throw new AgentRequestError(400, "invalid_request", "请求正文不是有效的 JSON 对象。");
  }
}

function readIdempotencyKey(context: Context): string {
  const value = context.req.header("idempotency-key");
  if (!value || !IDEMPOTENCY_KEY.test(value)) {
    throw new AgentRequestError(400, "invalid_request", "缺少有效的 Idempotency-Key。");
  }
  return value;
}

function parseDailyConfirmation(value: unknown): DailyConfirmationInput {
  const confirmation = requireRecord(value, "confirmation");
  requireExactKeys(confirmation, ["historicalDate", "replace"]);
  const historicalDate = confirmation.historicalDate;
  if (historicalDate !== null && !isDate(historicalDate)) {
    throw new AgentRequestError(400, "invalid_request", "historicalDate 必须是日期或 null。");
  }
  const replaceValue = confirmation.replace;
  if (replaceValue === null) return { historicalDate, replace: null } as DailyConfirmationInput;
  const replace = requireRecord(replaceValue, "confirmation.replace");
  requireExactKeys(replace, ["publicationId", "date", "expectedRevision"]);
  if (
    typeof replace.publicationId !== "string"
    || !PUBLICATION_ID.test(replace.publicationId)
    || !isDate(replace.date)
    || !Number.isInteger(replace.expectedRevision)
    || (replace.expectedRevision as number) < 1
  ) {
    throw new AgentRequestError(400, "invalid_request", "replace 确认目标无效。");
  }
  return {
    historicalDate,
    replace: {
      publicationId: replace.publicationId,
      date: replace.date,
      expectedRevision: replace.expectedRevision as number,
    },
  } as DailyConfirmationInput;
}

function parseDailyEnvelope(body: Record<string, unknown>): {
  mode: "update" | "replace";
  confirmation: DailyConfirmationInput;
  candidate: unknown;
} {
  requireExactKeys(body, ["mode", "confirmation", "candidate"]);
  if (body.mode !== "update" && body.mode !== "replace") {
    throw new AgentRequestError(400, "invalid_request", "mode 必须是 update 或 replace。");
  }
  if (!("candidate" in body) || !("confirmation" in body)) {
    throw new AgentRequestError(400, "invalid_request", "请求缺少 Candidate 或 confirmation。");
  }
  const confirmation = parseDailyConfirmation(body.confirmation);
  if (body.mode === "update" && confirmation.replace !== null) {
    throw new AgentRequestError(400, "invalid_request", "replace 确认只能用于 replace 模式。");
  }
  return {
    mode: body.mode as "update" | "replace",
    confirmation,
    candidate: body.candidate,
  };
}

function parseTodoEnvelope(body: Record<string, unknown>) {
  requireExactKeys(body, ["candidate"]);
  if (!("candidate" in body)) {
    throw new AgentRequestError(400, "invalid_request", "请求缺少 Todo Candidate。");
  }
  return { candidate: body.candidate };
}

function parseCreateThemeEnvelope(body: Record<string, unknown>) {
  requireExactKeys(body, ["theme"]);
  if (!("theme" in body)) throw new AgentRequestError(400, "invalid_request", "请求缺少主题定义。");
  return { theme: body.theme };
}

function parseUpdateThemeEnvelope(body: Record<string, unknown>) {
  requireExactKeys(body, ["baseRevision", "theme"]);
  if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 1 || !("theme" in body)) {
    throw new AgentRequestError(400, "invalid_request", "请求缺少合法的 baseRevision 或主题定义。");
  }
  return { baseRevision: body.baseRevision as number, theme: body.theme };
}

function readBaseRevision(context: Context): number {
  const value = context.req.header("if-match");
  const match = value ? /^"([1-9]\d*)"$/.exec(value) : null;
  if (!match) {
    throw new AgentRequestError(400, "invalid_request", "If-Match 必须使用带双引号的正整数 revision。");
  }
  return Number(match[1]);
}

function requireSingleDateQuery(context: Context): string | undefined {
  const url = new URL(context.req.url);
  const unknown = [...url.searchParams.keys()].filter((key) => key !== "date");
  if (unknown.length > 0 || url.searchParams.getAll("date").length > 1) {
    throw new AgentRequestError(400, "invalid_request", "查询参数无效。");
  }
  return url.searchParams.get("date") ?? undefined;
}

function assertNoQuery(context: Context): void {
  if ([...new URL(context.req.url).searchParams.keys()].length > 0) {
    throw new AgentRequestError(400, "invalid_request", "这个端点不接受查询参数。");
  }
}

function requirePathParameter(context: Context, name: string): string {
  const value = context.req.param(name);
  if (!value) throw new AgentRequestError(404, "target_not_found", "没有找到目标资源。");
  return value;
}

export function registerAgentApiRoutes(app: Hono, dependencies: AgentApiRouteDependencies): void {
  const route = (pathname: string) => `${dependencies.basePath}/api/v1${pathname}`;

  async function run(
    context: Context,
    action: AgentRequestAction,
    callback: (access: AgentRequestContext) => Promise<unknown>,
  ): Promise<Response> {
    const requestId = createAgentRequestId();
    context.header("X-Request-Id", requestId);
    try {
      const access = await dependencies.authenticator.authenticate({
        authorization: context.req.header("authorization"),
        clientIp: dependencies.clientIpResolver(context),
        action,
        requestId,
      });
      const result = await callback(access);
      return context.json({ ...(result as Record<string, unknown>), requestId });
    } catch (error) {
      return agentErrorResponse(context, error, requestId);
    }
  }

  app.get(route(API_ROUTES.publications.honoPath), (context) => run(
    context,
    "read",
    (access) => {
      assertNoQuery(context);
      return dependencies.operations.listPublications(access);
    },
  ));

  app.get(route(API_ROUTES.dailyContext.honoPath), (context) => run(
    context,
    "read",
    (access) => dependencies.operations.getDailyContext(
      access,
      requirePathParameter(context, "publicationId"),
      requireSingleDateQuery(context),
    ),
  ));

  app.post(route(API_ROUTES.dailyCandidates.honoPath), (context) => run(
    context,
    "write",
    async (access) => {
      assertNoQuery(context);
      const clientRunId = readIdempotencyKey(context);
      const envelope = parseDailyEnvelope(await readJsonBody(context.req.raw, dependencies.requestBodyLimitBytes));
      return dependencies.operations.submitDailyCandidate(access, {
        publicationId: requirePathParameter(context, "publicationId"),
        clientRunId,
        ...envelope,
      });
    },
  ));

  app.get(route(API_ROUTES.dailyIssue.honoPath), (context) => run(
    context,
    "read",
    (access) => {
      assertNoQuery(context);
      return dependencies.operations.getDailyIssue(
        access,
        requirePathParameter(context, "publicationId"),
        requirePathParameter(context, "date"),
      );
    },
  ));

  app.get(route(API_ROUTES.todo.honoPath), (context) => run(
    context,
    "read",
    (access) => {
      assertNoQuery(context);
      return dependencies.operations.getTodo(access);
    },
  ));

  app.post(route(API_ROUTES.todoCandidates.honoPath), (context) => run(context, "write", async (access) => {
    assertNoQuery(context);
    const clientRunId = readIdempotencyKey(context);
    const envelope = parseTodoEnvelope(await readJsonBody(context.req.raw, dependencies.requestBodyLimitBytes));
    return dependencies.operations.submitTodoCandidate(access, { clientRunId, ...envelope });
  }));

  app.get(route(API_ROUTES.themeContext.honoPath), (context) => run(context, "read", (access) => {
    assertNoQuery(context);
    return dependencies.operations.getThemeContext(access);
  }));

  app.get(route(API_ROUTES.theme.honoPath), (context) => run(context, "read", (access) => {
    assertNoQuery(context);
    return dependencies.operations.getTheme(access, requirePathParameter(context, "themeId"));
  }));

  app.post(route(API_ROUTES.createTheme.honoPath), (context) => run(context, "write", async (access) => {
    assertNoQuery(context);
    const clientRunId = readIdempotencyKey(context);
    const envelope = parseCreateThemeEnvelope(await readJsonBody(context.req.raw, dependencies.requestBodyLimitBytes));
    return dependencies.operations.createTheme(access, { clientRunId, ...envelope });
  }));

  app.put(route(API_ROUTES.updateTheme.honoPath), (context) => run(context, "write", async (access) => {
    assertNoQuery(context);
    const clientRunId = readIdempotencyKey(context);
    const envelope = parseUpdateThemeEnvelope(await readJsonBody(context.req.raw, dependencies.requestBodyLimitBytes));
    return dependencies.operations.updateTheme(access, {
      themeId: requirePathParameter(context, "themeId"),
      clientRunId,
      ...envelope,
    });
  }));

  app.delete(route(API_ROUTES.deleteTheme.honoPath), (context) => run(context, "write", (access) => {
    assertNoQuery(context);
    return dependencies.operations.deleteTheme(access, {
      themeId: requirePathParameter(context, "themeId"),
      clientRunId: readIdempotencyKey(context),
      baseRevision: readBaseRevision(context),
    });
  }));

  const unmatched = (context: Context) => run(
    context,
    context.req.method === "GET" || context.req.method === "HEAD" ? "read" : "write",
    async () => {
      throw new AgentRequestError(404, "target_not_found", "没有找到 API 资源。");
    },
  );
  app.all(route(""), unmatched);
  app.all(route("/*"), unmatched);
}
