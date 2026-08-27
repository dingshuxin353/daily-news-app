import { createHmac, timingSafeEqual } from "node:crypto";
import { AgentAccessError } from "../modules/agent-access/credential-service.js";

function csrfDigest(secret: string, sessionId: string, userId: string): Buffer {
  return createHmac("sha256", secret)
    .update("dailynews-settings-csrf-v1")
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(userId)
    .digest();
}

export function createSettingsCsrfToken(secret: string, sessionId: string, userId: string): string {
  return csrfDigest(secret, sessionId, userId).toString("base64url");
}

export function verifySettingsCsrfToken(
  secret: string,
  sessionId: string,
  userId: string,
  received: unknown,
): boolean {
  if (typeof received !== "string") return false;
  let receivedBuffer: Buffer;
  try {
    receivedBuffer = Buffer.from(received, "base64url");
  } catch {
    return false;
  }
  const expected = csrfDigest(secret, sessionId, userId);
  return receivedBuffer.length === expected.length && timingSafeEqual(expected, receivedBuffer);
}

export async function readSettingsBody(request: Request, bodyLimitBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") {
    throw new AgentAccessError(400, "invalid_request", "请求格式无效。");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > bodyLimitBytes) {
    throw new AgentAccessError(400, "invalid_request", "请求内容过大。");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > bodyLimitBytes) {
        await reader.cancel();
        throw new AgentAccessError(400, "invalid_request", "请求内容过大。");
      }
      chunks.push(Buffer.from(value));
    }
  }
  const body = Buffer.concat(chunks, total);
  try {
    if (contentType === "application/json") {
      const value = JSON.parse(body.toString("utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
      return value as Record<string, unknown>;
    }
    return Object.fromEntries(new URLSearchParams(body.toString("utf8")));
  } catch {
    throw new AgentAccessError(400, "invalid_request", "请求格式无效。");
  }
}

export function assertBrowserMutation(input: {
  request: Request;
  requestOrigin: string | null;
  configuredOrigin: string;
  csrfSecret: string;
  sessionId: string;
  userId: string;
  body: Record<string, unknown>;
}): void {
  if (
    input.requestOrigin !== input.configuredOrigin
    || input.request.headers.get("origin") !== input.configuredOrigin
    || !verifySettingsCsrfToken(
      input.csrfSecret,
      input.sessionId,
      input.userId,
      input.request.headers.get("x-csrf-token") ?? input.body._csrf,
    )
  ) {
    throw new AgentAccessError(403, "request_forbidden", "请求未通过安全检查。");
  }
}

export function resolveTrustedExternalOrigin(input: {
  requestUrl: string;
  requestHost: string | undefined;
  transportProtocol: "http" | "https";
  configuredOrigin: string;
  remoteAddress: string | undefined;
  forwardedProto: string | undefined;
}): string | null {
  const requestUrl = new URL(input.requestUrl);
  const configuredUrl = new URL(input.configuredOrigin);
  const remote = input.remoteAddress?.startsWith("::ffff:")
    ? input.remoteAddress.slice(7)
    : input.remoteAddress;
  const remoteIsLoopback = remote === "127.0.0.1" || remote === "::1";
  const configuredHostIsLoopback = configuredUrl.hostname === "127.0.0.1"
    || configuredUrl.hostname === "localhost"
    || configuredUrl.hostname === "[::1]";
  if (configuredUrl.protocol === "http:" && (!configuredHostIsLoopback || !remoteIsLoopback)) {
    return null;
  }
  const requestHost = input.requestHost?.trim().toLowerCase();
  if (
    !requestHost
    || requestHost !== configuredUrl.host.toLowerCase()
    || requestUrl.host.toLowerCase() !== requestHost
  ) {
    return null;
  }

  const transportOrigin = new URL(`${input.transportProtocol}://${requestHost}`).origin;
  if (transportOrigin === configuredUrl.origin) return configuredUrl.origin;

  if (!remoteIsLoopback) return transportOrigin;
  if (!input.forwardedProto || input.forwardedProto.includes(",")) return transportOrigin;

  if (`${input.forwardedProto.trim().toLowerCase()}:` !== configuredUrl.protocol) return transportOrigin;
  return configuredUrl.origin;
}
