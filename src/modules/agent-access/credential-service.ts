import { randomUUID } from "node:crypto";
import { jsonSha256 } from "../shared/canonical-json.js";
import type { TenantContext } from "../../adapters/postgres/tenancy.js";
import { constantTimeDigestEquals, digestAgentTokenSecret, issueAgentToken, parseAgentToken } from "./token-secret.js";

export type AgentAccessErrorCode =
  | "invalid_request"
  | "request_forbidden"
  | "authentication_failed"
  | "profile_incomplete"
  | "credential_limit_reached"
  | "operation_conflict"
  | "rate_limited"
  | "target_not_found"
  | "service_unavailable";

export class AgentAccessError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    readonly code: AgentAccessErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AgentAccessError";
  }
}

export interface AgentAccessConfiguration {
  tokenDigestSecret: string;
  activeCredentialLimit: number;
}

export interface CredentialRecord {
  id: string;
  spaceId: string;
  name: string;
  selector: string;
  secretDigest: string;
  tokenHint: string;
  status: "active" | "rotated" | "revoked";
  rotatedFromId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface AgentAccessRepository {
  listCredentials(tenant: TenantContext): Promise<CredentialRecord[]>;
  issueCredential(input: CredentialIssueInput): Promise<{ credential: CredentialRecord; repeated: boolean }>;
  rotateCredential(input: CredentialRotateInput): Promise<{ credential: CredentialRecord; repeated: boolean }>;
  revokeCredential(input: CredentialRevokeInput): Promise<CredentialRecord>;
  renameCredential(input: CredentialRenameInput): Promise<CredentialRecord>;
  findCredentialBySelector(selector: string): Promise<CredentialRecord | null>;
}

export interface CredentialIssueInput {
  tenant: TenantContext;
  credentialId: string;
  name: string;
  selector: string;
  secretDigest: string;
  tokenHint: string;
  operationId: string;
  payloadHash: string;
  activeCredentialLimit: number;
  requestId: string;
  actorDigest: string;
}

export interface CredentialRotateInput extends CredentialIssueInput {
  targetCredentialId: string;
}

export interface CredentialRevokeInput {
  tenant: TenantContext;
  targetCredentialId: string;
  requestId: string;
  actorDigest: string;
}

export interface CredentialRenameInput extends CredentialRevokeInput {
  name: string;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new AgentAccessError(400, "invalid_request", "Token 名称无效。");
  const name = value.normalize("NFKC").trim();
  if (name.length === 0 || [...name].length > 80 || /[\p{Cc}\u2028\u2029]/u.test(name)) {
    throw new AgentAccessError(400, "invalid_request", "Token 名称无效。");
  }
  return name;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AgentAccessError(400, "invalid_request", `${label} 无效。`);
  }
  return value;
}

export class AgentCredentialService {
  constructor(
    private readonly repository: AgentAccessRepository,
    private readonly config: AgentAccessConfiguration,
  ) {}

  async authenticateActiveToken(authorization: unknown): Promise<CredentialRecord> {
    const parsed = this.parseAuthorization(authorization);
    if (!parsed) throw new AgentAccessError(401, "authentication_failed", "连接密钥无效或已失效。");
    const credential = await this.repository.findCredentialBySelector(parsed.selector);
    const expectedDigest = credential?.secretDigest ?? "0".repeat(64);
    const receivedDigest = digestAgentTokenSecret(this.config.tokenDigestSecret, parsed.selector, parsed.secret);
    if (!constantTimeDigestEquals(expectedDigest, receivedDigest) || !credential || credential.status !== "active") {
      throw new AgentAccessError(401, "authentication_failed", "连接密钥无效或已失效。");
    }
    return credential;
  }

  async listCredentials(tenant: TenantContext) {
    return this.repository.listCredentials(tenant);
  }

  async issueCredential(
    tenant: TenantContext,
    input: { name: unknown; operationId: unknown },
    requestId: string,
    actorDigest: string,
  ) {
    const name = normalizeName(input.name);
    const operationId = requireUuid(input.operationId, "操作标识");
    const issued = issueAgentToken(this.config.tokenDigestSecret);
    const result = await this.repository.issueCredential({
      tenant,
      credentialId: randomUUID(),
      name,
      selector: issued.selector,
      secretDigest: issued.secretDigest,
      tokenHint: issued.hint,
      operationId,
      payloadHash: jsonSha256({ type: "create", name }),
      activeCredentialLimit: this.config.activeCredentialLimit,
      requestId,
      actorDigest,
    });
    return { credential: result.credential, token: result.repeated ? null : issued.token, repeated: result.repeated };
  }

  async rotateCredential(
    tenant: TenantContext,
    targetCredentialId: unknown,
    input: { name: unknown; operationId: unknown },
    requestId: string,
    actorDigest: string,
  ) {
    const targetId = requireUuid(targetCredentialId, "Token 标识");
    const name = normalizeName(input.name);
    const operationId = requireUuid(input.operationId, "操作标识");
    const issued = issueAgentToken(this.config.tokenDigestSecret);
    const result = await this.repository.rotateCredential({
      tenant,
      targetCredentialId: targetId,
      credentialId: randomUUID(),
      name,
      selector: issued.selector,
      secretDigest: issued.secretDigest,
      tokenHint: issued.hint,
      operationId,
      payloadHash: jsonSha256({ type: "rotate", targetId, name }),
      activeCredentialLimit: this.config.activeCredentialLimit,
      requestId,
      actorDigest,
    });
    return { credential: result.credential, token: result.repeated ? null : issued.token, repeated: result.repeated };
  }

  async revokeCredential(tenant: TenantContext, targetCredentialId: unknown, requestId: string, actorDigest: string) {
    return this.repository.revokeCredential({
      tenant,
      targetCredentialId: requireUuid(targetCredentialId, "Token 标识"),
      requestId,
      actorDigest,
    });
  }

  async renameCredential(tenant: TenantContext, targetCredentialId: unknown, name: unknown, requestId: string, actorDigest: string) {
    return this.repository.renameCredential({
      tenant,
      targetCredentialId: requireUuid(targetCredentialId, "Token 标识"),
      name: normalizeName(name),
      requestId,
      actorDigest,
    });
  }

  private parseAuthorization(value: unknown) {
    if (typeof value !== "string") return null;
    const match = /^Bearer ([^\s]+)$/i.exec(value);
    return match ? parseAgentToken(match[1]) : null;
  }
}
