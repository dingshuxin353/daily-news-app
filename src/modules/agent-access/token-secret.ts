import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "dnpat";
const TOKEN_PATTERN = /^dnpat_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;

export interface IssuedAgentToken {
  token: string;
  selector: string;
  secretDigest: string;
  hint: string;
}

export interface ParsedAgentToken {
  selector: string;
  secret: string;
}

function hmac(secret: string, purpose: string, value: string): Buffer {
  return createHmac("sha256", secret)
    .update(purpose)
    .update("\0")
    .update(value)
    .digest();
}

export function digestAgentTokenSecret(
  digestSecret: string,
  selector: string,
  secret: string,
): string {
  return hmac(digestSecret, "agent-token-v1", `${selector}\0${secret}`).toString("hex");
}

export function issueAgentToken(digestSecret: string): IssuedAgentToken {
  const selector = randomBytes(16).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const token = `${TOKEN_PREFIX}_${selector}_${secret}`;
  return {
    token,
    selector,
    secretDigest: digestAgentTokenSecret(digestSecret, selector, secret),
    hint: `${TOKEN_PREFIX}_${selector.slice(0, 6)}…${secret.slice(-4)}`,
  };
}

export function parseAgentToken(value: unknown): ParsedAgentToken | null {
  if (typeof value !== "string") return null;
  const match = TOKEN_PATTERN.exec(value);
  return match ? { selector: match[1], secret: match[2] } : null;
}

export function constantTimeDigestEquals(expectedHex: string, receivedHex: string): boolean {
  const expected = Buffer.from(expectedHex.padEnd(64, "0").slice(0, 64), "hex");
  const received = Buffer.from(receivedHex.padEnd(64, "0").slice(0, 64), "hex");
  return timingSafeEqual(expected, received) && expectedHex.length === 64 && receivedHex.length === 64;
}
