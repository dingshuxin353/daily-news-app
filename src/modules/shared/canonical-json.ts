import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {
  readonly code = "CANONICAL_JSON_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function normalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new CanonicalJsonError("JSON values must not contain cycles");
    ancestors.add(value);
    try {
      return value.map((entry) => {
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          throw new CanonicalJsonError("JSON arrays must not contain unsupported values");
        }
        return normalize(entry, ancestors);
      });
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new CanonicalJsonError("JSON values must not contain cycles");
    ancestors.add(value);
    try {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          throw new CanonicalJsonError("JSON objects must not contain unsupported values");
        }
        output[key] = normalize(entry, ancestors);
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new CanonicalJsonError("value is not representable as JSON");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}

export function jsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
