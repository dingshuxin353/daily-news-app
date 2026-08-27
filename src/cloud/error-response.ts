import type { Context } from "hono";
import { AgentRequestError } from "../modules/agent-access/request-policy.js";

export function agentErrorResponse(context: Context, error: unknown, requestId: string): Response {
  const publicError = error instanceof AgentRequestError
    ? error
    : new AgentRequestError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
  if (publicError.status === 401) context.header("WWW-Authenticate", "Bearer");
  if (publicError.status === 429 && publicError.retryAfterSeconds) {
    context.header("Retry-After", String(publicError.retryAfterSeconds));
  }
  return context.json({
    error: {
      code: publicError.code,
      message: publicError.message,
      requestId,
    },
  }, publicError.status);
}
