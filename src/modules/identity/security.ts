import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export type IdentityPublicErrorCode = "request_failed" | "rate_limited" | "service_unavailable";

export class IdentityPublicError extends Error {
  constructor(
    readonly status: 400 | 403 | 429 | 503,
    readonly code: IdentityPublicErrorCode,
  ) {
    super(code);
    this.name = "IdentityPublicError";
  }
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new IdentityPublicError(400, "request_failed");
  const email = value.normalize("NFKC").trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new IdentityPublicError(400, "request_failed");
  }
  return email;
}

export function keyedDigest(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function normalizeIp(value: string | undefined): string | null {
  if (!value) return null;
  const ip = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(ip) ? ip : null;
}

export function resolveTrustedClientIp(options: {
  remoteAddress: string | undefined;
  forwardedAddress: string | undefined;
}): string {
  const remote = normalizeIp(options.remoteAddress);
  if (!remote) return "0.0.0.0";
  if (remote !== "127.0.0.1" && remote !== "::1") return remote;
  if (!options.forwardedAddress || options.forwardedAddress.includes(",")) return remote;
  return normalizeIp(options.forwardedAddress.trim()) ?? remote;
}
