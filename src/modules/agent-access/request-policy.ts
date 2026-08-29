import type { TenantContext } from "../../adapters/postgres/tenancy.js";

export type AgentRequestAction = "read" | "write";

export type AgentRequestErrorCode =
  | "invalid_request"
  | "schema_invalid"
  | "future_date_not_allowed"
  | "invalid_token"
  | "target_not_found"
  | "idempotency_conflict"
  | "revision_conflict"
  | "explicit_confirmation_required"
  | "publication_inactive"
  | "todo_disabled"
  | "theme_conflict"
  | "theme_read_only"
  | "theme_in_use"
  | "theme_limit_reached"
  | "payload_too_large"
  | "rate_limited"
  | "service_unavailable";

export class AgentRequestError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 413 | 429 | 503,
    readonly code: AgentRequestErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

export interface AgentRequestContext {
  requestId: string;
  credentialId: string;
  credentialName: string;
  tenant: TenantContext;
}

export interface AgentRequestPolicyLimits {
  tokenHourlyLimit: number;
  ipHourlyLimit: number;
  retentionHours: number;
}

export interface AgentRequestPolicyRepository {
  reserveRequest(input: {
    action: AgentRequestAction;
    tokenDigest: string;
    ipDigest: string;
    limits: AgentRequestPolicyLimits;
  }): Promise<void>;
  touchCredentialLastUsed(credentialId: string, minimumIntervalSeconds: number): Promise<void>;
  withWriteLease<T>(input: {
    tenant: TenantContext;
    credentialId: string;
    requestId: string;
    concurrentLimit: number;
    ttlSeconds: number;
  }, work: () => Promise<T>): Promise<T>;
}
