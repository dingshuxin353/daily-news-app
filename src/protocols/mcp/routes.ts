import { isJsonContentType, isLegacyRequest } from "@modelcontextprotocol/server";
import { type Context, type Hono } from "hono";
import type { AgentRequestAuthenticator } from "../../cloud/agent-context.js";
import { createAgentRequestId } from "../../cloud/agent-context.js";
import { agentErrorResponse } from "../../cloud/error-response.js";
import type { AgentOperationsService } from "../../modules/agent-access/operations.js";
import type { AgentRequestAction } from "../../modules/agent-access/request-policy.js";
import { AgentRequestError } from "../../modules/agent-access/request-policy.js";
import { createAgentMcpAuthInfo, createAgentMcpHandler } from "./server.js";

const WRITE_TOOLS = new Set(["submit_daily_candidate", "submit_todo_candidate"]);

export interface AgentMcpRouteDependencies {
  basePath: string;
  origin: string;
  authenticator: AgentRequestAuthenticator;
  operations: AgentOperationsService;
  clientIpResolver: (context: Context) => string;
  requestOriginResolver: (context: Context) => string | null;
  requestBodyLimitBytes: number;
  dailyItemLimit: number;
  todoOperationLimit: number;
}

function protocolError(status: number, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message },
  }, { status });
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function originMatches(value: string | undefined, configuredOrigin: string): boolean {
  if (value === undefined) return true;
  try {
    return value === new URL(configuredOrigin).origin && new URL(value).origin === value;
  } catch {
    return false;
  }
}

async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    throw new AgentRequestError(413, "payload_too_large", "请求内容超过允许大小。");
  }
  const reader = request.clone().body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel();
        throw new AgentRequestError(413, "payload_too_large", "请求内容超过允许大小。");
      }
      chunks.push(value);
    }
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function requestAction(parsedBody: unknown): AgentRequestAction {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  for (const value of messages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const message = value as { method?: unknown; params?: unknown };
    if (message.method !== "tools/call" || !message.params || typeof message.params !== "object") continue;
    const name = (message.params as { name?: unknown }).name;
    if (typeof name === "string" && WRITE_TOOLS.has(name)) return "write";
  }
  return "read";
}

export function registerAgentMcpRoute(app: Hono, dependencies: AgentMcpRouteDependencies): void {
  const handler = createAgentMcpHandler({
    operations: dependencies.operations,
    dailyItemLimit: dependencies.dailyItemLimit,
    todoOperationLimit: dependencies.todoOperationLimit,
  });
  const route = `${dependencies.basePath}/mcp`;

  app.all(route, async (context) => {
    const requestId = createAgentRequestId();
    context.header("X-Request-Id", requestId);
    if (context.req.method !== "POST") {
      context.header("Allow", "POST");
      return context.body("Method not allowed.", 405);
    }
    if (
      dependencies.requestOriginResolver(context) !== dependencies.origin
      || !originMatches(context.req.header("origin"), dependencies.origin)
    ) {
      return withRequestId(protocolError(403, "Forbidden"), requestId);
    }
    if (!isJsonContentType(context.req.header("content-type"))) {
      return withRequestId(protocolError(415, "Content-Type must be application/json"), requestId);
    }
    try {
      const parsedBody = await readBoundedJson(context.req.raw, dependencies.requestBodyLimitBytes);
      const access = await dependencies.authenticator.authenticate({
        authorization: context.req.header("authorization"),
        clientIp: dependencies.clientIpResolver(context),
        action: requestAction(parsedBody),
        requestId,
      });
      if (
        parsedBody !== undefined
        && !(await isLegacyRequest(context.req.raw, parsedBody))
        && !context.req.header("mcp-protocol-version")
      ) {
        return withRequestId(
          protocolError(400, "MCP-Protocol-Version is required for modern requests"),
          requestId,
        );
      }
      return withRequestId(await handler.fetch(context.req.raw, {
        authInfo: createAgentMcpAuthInfo(access),
        ...(parsedBody === undefined ? {} : { parsedBody }),
      }), requestId);
    } catch (error) {
      return agentErrorResponse(context, error, requestId);
    }
  });
}
