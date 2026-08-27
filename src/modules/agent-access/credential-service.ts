import { randomUUID } from "node:crypto";
import { jsonSha256 } from "../shared/canonical-json.js";
import type { TenantContext } from "../../adapters/postgres/tenancy.js";
import {
  constantTimeDigestEquals,
  derivePairingCode,
  digestAgentTokenSecret,
  digestPairingCode,
  issueAgentToken,
  normalizePairingCode,
  parseAgentToken,
} from "./token-secret.js";

export type AgentAccessErrorCode =
  | "invalid_request"
  | "request_forbidden"
  | "authentication_failed"
  | "pairing_unavailable"
  | "pairing_in_progress"
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
  pairingCodeDigestSecret: string;
  activeCredentialLimit: number;
  pairingCodeTtlSeconds: number;
  provisioningTtlSeconds: number;
  claimIpHourlyLimit: number;
  verifyIpHourlyLimit: number;
  apiBaseUrl: string;
  mcpUrl: string;
  pairingVerifyUrl: string;
}

export interface PairingRecord {
  id: string;
  spaceId: string;
  intendedName: string;
  purpose: "bootstrap" | "additional";
  status: "pending" | "claimed" | "verified" | "cancelled" | "expired";
  codeGeneration: number;
  expiresAt: Date;
  claimStartedAt: Date | null;
  provisioningCredentialId: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CredentialRecord {
  id: string;
  spaceId: string;
  name: string;
  selector: string;
  secretDigest: string;
  tokenHint: string;
  status: "provisioning" | "active" | "rotated" | "revoked";
  rotatedFromId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface VerifiedPairingContext {
  publicationId: string;
  publicationName: string;
  timeZone: string;
  todoEnabled: boolean;
}

export interface AgentAccessRepository {
  reservePairingRequest(
    action: "pairing_claim" | "pairing_verify",
    ipDigest: string,
    limit: number,
  ): Promise<void>;
  ensureBootstrapPairing(input: PairingCreateInput): Promise<PairingRecord>;
  createPairing(input: PairingCreateInput): Promise<{ record: PairingRecord; repeated: boolean }>;
  getPairing(tenant: TenantContext, pairingId: string): Promise<PairingRecord | null>;
  listPairings(tenant: TenantContext): Promise<PairingRecord[]>;
  refreshPairing(input: PairingRefreshInput): Promise<PairingRecord>;
  cancelClaimAndRefresh(input: PairingRefreshInput): Promise<PairingRecord>;
  claimPairing(input: PairingClaimInput): Promise<{ pairing: PairingRecord; credential: CredentialRecord }>;
  verifyPairing(input: PairingVerifyInput): Promise<{ context: VerifiedPairingContext; credential: CredentialRecord }>;
  listCredentials(tenant: TenantContext): Promise<CredentialRecord[]>;
  issueManualCredential(input: CredentialIssueInput): Promise<{ credential: CredentialRecord; repeated: boolean }>;
  rotateCredential(input: CredentialRotateInput): Promise<{ credential: CredentialRecord; repeated: boolean }>;
  revokeCredential(input: CredentialRevokeInput): Promise<CredentialRecord>;
  renameCredential(input: CredentialRenameInput): Promise<CredentialRecord>;
  findCredentialBySelector(selector: string): Promise<CredentialRecord | null>;
}

export interface PairingCreateInput {
  tenant: TenantContext;
  id: string;
  intendedName: string;
  purpose: "bootstrap" | "additional";
  operationId: string;
  payloadHash: string;
  codeDigest: string;
  expiresAt: Date;
  activeCredentialLimit: number;
  requestId: string;
  actorDigest: string;
}

export interface PairingRefreshInput {
  tenant: TenantContext;
  pairingId: string;
  codeGeneration: number;
  codeDigest: string;
  expiresAt: Date;
  requestId: string;
  actorDigest: string;
}

export interface PairingClaimInput {
  codeDigest: string;
  clientName: string;
  credentialId: string;
  selector: string;
  secretDigest: string;
  tokenHint: string;
  operationId: string;
  payloadHash: string;
  expiresAt: Date;
  activeCredentialLimit: number;
  ipDigest: string;
  requestId: string;
}

export interface PairingVerifyInput {
  credentialId: string;
  selector: string;
  authorizationValid: boolean;
  requestId: string;
  actorDigest: string;
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

function addSeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new AgentAccessError(400, "invalid_request", "连接名称无效。");
  const name = value.normalize("NFKC").trim();
  if (
    name.length === 0
    || [...name].length > 80
    || /[\p{Cc}\u2028\u2029]/u.test(name)
  ) {
    throw new AgentAccessError(400, "invalid_request", "连接名称无效。");
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
    private readonly now: () => Date = () => new Date(),
  ) {}

  private pairingView(record: PairingRecord) {
    return {
      ...record,
      code: record.status === "pending"
        ? derivePairingCode(this.config.pairingCodeDigestSecret, record.id, record.codeGeneration)
        : null,
    };
  }

  async ensureBootstrapPairing(tenant: TenantContext, requestId: string, actorDigest: string) {
    const id = randomUUID();
    const operationId = randomUUID();
    const intendedName = "我的 Agent";
    const generation = 1;
    const now = this.now();
    const code = derivePairingCode(this.config.pairingCodeDigestSecret, id, generation);
    const normalized = normalizePairingCode(code);
    if (!normalized) throw new Error("derived pairing code is invalid");
    const record = await this.repository.ensureBootstrapPairing({
      tenant,
      id,
      intendedName,
      purpose: "bootstrap",
      operationId,
      payloadHash: jsonSha256({ purpose: "bootstrap", intendedName }),
      codeDigest: digestPairingCode(this.config.pairingCodeDigestSecret, normalized),
      expiresAt: addSeconds(now, this.config.pairingCodeTtlSeconds),
      activeCredentialLimit: this.config.activeCredentialLimit,
      requestId,
      actorDigest,
    });
    return this.pairingView(record);
  }

  async createPairing(
    tenant: TenantContext,
    input: { name: unknown; operationId: unknown },
    requestId: string,
    actorDigest: string,
  ) {
    const intendedName = normalizeName(input.name);
    const operationId = requireUuid(input.operationId, "操作标识");
    const id = randomUUID();
    const generation = 1;
    const code = derivePairingCode(this.config.pairingCodeDigestSecret, id, generation);
    const normalized = normalizePairingCode(code);
    if (!normalized) throw new Error("derived pairing code is invalid");
    const result = await this.repository.createPairing({
      tenant,
      id,
      intendedName,
      purpose: "additional",
      operationId,
      payloadHash: jsonSha256({ purpose: "additional", intendedName }),
      codeDigest: digestPairingCode(this.config.pairingCodeDigestSecret, normalized),
      expiresAt: addSeconds(this.now(), this.config.pairingCodeTtlSeconds),
      activeCredentialLimit: this.config.activeCredentialLimit,
      requestId,
      actorDigest,
    });
    return { ...this.pairingView(result.record), repeated: result.repeated };
  }

  async getPairing(tenant: TenantContext, pairingId: unknown, requestId: string, actorDigest: string) {
    const id = requireUuid(pairingId, "连接标识");
    const record = await this.repository.getPairing(tenant, id);
    if (!record) throw new AgentAccessError(404, "target_not_found", "没有找到这条连接。");
    if (record.status === "expired" || (record.status === "pending" && record.expiresAt.getTime() <= this.now().getTime())) {
      return this.refreshPairing(tenant, id, requestId, actorDigest);
    }
    return this.pairingView(record);
  }

  async listPairings(tenant: TenantContext, requestId: string, actorDigest: string) {
    const records = await this.repository.listPairings(tenant);
    const result = [];
    for (const record of records) {
      if (record.status === "expired" || (record.status === "pending" && record.expiresAt.getTime() <= this.now().getTime())) {
        result.push(await this.refreshPairing(tenant, record.id, requestId, actorDigest));
      } else {
        result.push(this.pairingView(record));
      }
    }
    return result;
  }

  async refreshPairing(tenant: TenantContext, pairingId: unknown, requestId: string, actorDigest: string) {
    const id = requireUuid(pairingId, "连接标识");
    const current = await this.repository.getPairing(tenant, id);
    if (!current) throw new AgentAccessError(404, "target_not_found", "没有找到这条连接。");
    if (current.status !== "pending" && current.status !== "expired") {
      throw new AgentAccessError(409, "pairing_in_progress", "Agent 已开始连接，请先取消本次连接。");
    }
    const generation = current.codeGeneration + 1;
    const code = derivePairingCode(this.config.pairingCodeDigestSecret, id, generation);
    const normalized = normalizePairingCode(code);
    if (!normalized) throw new Error("derived pairing code is invalid");
    const record = await this.repository.refreshPairing({
      tenant,
      pairingId: id,
      codeGeneration: generation,
      codeDigest: digestPairingCode(this.config.pairingCodeDigestSecret, normalized),
      expiresAt: addSeconds(this.now(), this.config.pairingCodeTtlSeconds),
      requestId,
      actorDigest,
    });
    return this.pairingView(record);
  }

  async cancelClaimAndRefresh(tenant: TenantContext, pairingId: unknown, requestId: string, actorDigest: string) {
    const id = requireUuid(pairingId, "连接标识");
    const current = await this.repository.getPairing(tenant, id);
    if (!current) throw new AgentAccessError(404, "target_not_found", "没有找到这条连接。");
    if (current.status !== "claimed") {
      throw new AgentAccessError(409, "pairing_unavailable", "这条连接当前不能取消。");
    }
    const generation = current.codeGeneration + 1;
    const code = derivePairingCode(this.config.pairingCodeDigestSecret, id, generation);
    const normalized = normalizePairingCode(code);
    if (!normalized) throw new Error("derived pairing code is invalid");
    const record = await this.repository.cancelClaimAndRefresh({
      tenant,
      pairingId: id,
      codeGeneration: generation,
      codeDigest: digestPairingCode(this.config.pairingCodeDigestSecret, normalized),
      expiresAt: addSeconds(this.now(), this.config.pairingCodeTtlSeconds),
      requestId,
      actorDigest,
    });
    return this.pairingView(record);
  }

  async claimPairing(input: { code: unknown; clientName: unknown; ipDigest: string; requestId: string }) {
    await this.repository.reservePairingRequest("pairing_claim", input.ipDigest, this.config.claimIpHourlyLimit);
    const normalizedCode = normalizePairingCode(input.code) ?? "0000000000";
    const clientName = normalizeName(input.clientName);
    const issued = issueAgentToken(this.config.tokenDigestSecret);
    const credentialId = randomUUID();
    const operationId = randomUUID();
    const payloadHash = jsonSha256({ type: "pairing_claim", clientName });
    const result = await this.repository.claimPairing({
      codeDigest: digestPairingCode(this.config.pairingCodeDigestSecret, normalizedCode),
      clientName,
      credentialId,
      selector: issued.selector,
      secretDigest: issued.secretDigest,
      tokenHint: issued.hint,
      operationId,
      payloadHash,
      expiresAt: addSeconds(this.now(), this.config.provisioningTtlSeconds),
      activeCredentialLimit: this.config.activeCredentialLimit,
      requestId: input.requestId,
    });
    return {
      credentialId: result.credential.id,
      token: issued.token,
      expiresAt: result.credential.expiresAt,
      verifyUrl: this.config.pairingVerifyUrl,
      apiBaseUrl: this.config.apiBaseUrl,
      mcpUrl: this.config.mcpUrl,
    };
  }

  async verifyPairing(input: { authorization: unknown; ipDigest: string; requestId: string }) {
    await this.repository.reservePairingRequest("pairing_verify", input.ipDigest, this.config.verifyIpHourlyLimit);
    const parsedAuthorization = this.parseAuthorization(input.authorization);
    if (!parsedAuthorization) {
      throw new AgentAccessError(401, "authentication_failed", "连接密钥无效或已失效。");
    }
    const parsed = parsedAuthorization;
    const credential = await this.repository.findCredentialBySelector(parsed.selector);
    const expectedDigest = credential?.secretDigest ?? "0".repeat(64);
    const receivedDigest = digestAgentTokenSecret(this.config.tokenDigestSecret, parsed.selector, parsed.secret);
    const authorizationValid = constantTimeDigestEquals(expectedDigest, receivedDigest)
      && credential?.status === "provisioning";
    return this.repository.verifyPairing({
      credentialId: credential?.id ?? "00000000-0000-4000-8000-000000000000",
      selector: parsed.selector,
      authorizationValid,
      ipDigest: input.ipDigest,
      requestId: input.requestId,
      actorDigest: receivedDigest,
    });
  }

  async authenticateActiveToken(authorization: unknown): Promise<CredentialRecord> {
    const parsed = this.parseAuthorization(authorization);
    if (!parsed) throw new AgentAccessError(401, "authentication_failed", "连接密钥无效或已失效。");
    const credential = await this.repository.findCredentialBySelector(parsed.selector);
    const expectedDigest = credential?.secretDigest ?? "0".repeat(64);
    const receivedDigest = digestAgentTokenSecret(this.config.tokenDigestSecret, parsed.selector, parsed.secret);
    if (
      !constantTimeDigestEquals(expectedDigest, receivedDigest)
      || !credential
      || credential.status !== "active"
    ) {
      throw new AgentAccessError(401, "authentication_failed", "连接密钥无效或已失效。");
    }
    return credential;
  }

  async listCredentials(tenant: TenantContext) {
    return this.repository.listCredentials(tenant);
  }

  async issueManualCredential(
    tenant: TenantContext,
    input: { name: unknown; operationId: unknown },
    requestId: string,
    actorDigest: string,
  ) {
    const name = normalizeName(input.name);
    const operationId = requireUuid(input.operationId, "操作标识");
    const issued = issueAgentToken(this.config.tokenDigestSecret);
    const result = await this.repository.issueManualCredential({
      tenant,
      credentialId: randomUUID(),
      name,
      selector: issued.selector,
      secretDigest: issued.secretDigest,
      tokenHint: issued.hint,
      operationId,
      payloadHash: jsonSha256({ type: "manual_create", name }),
      activeCredentialLimit: this.config.activeCredentialLimit,
      requestId,
      actorDigest,
    });
    return {
      credential: result.credential,
      token: result.repeated ? null : issued.token,
      repeated: result.repeated,
    };
  }

  async rotateCredential(
    tenant: TenantContext,
    targetCredentialId: unknown,
    input: { name: unknown; operationId: unknown },
    requestId: string,
    actorDigest: string,
  ) {
    const targetId = requireUuid(targetCredentialId, "连接标识");
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
    return {
      credential: result.credential,
      token: result.repeated ? null : issued.token,
      repeated: result.repeated,
    };
  }

  async revokeCredential(
    tenant: TenantContext,
    targetCredentialId: unknown,
    requestId: string,
    actorDigest: string,
  ) {
    return this.repository.revokeCredential({
      tenant,
      targetCredentialId: requireUuid(targetCredentialId, "连接标识"),
      requestId,
      actorDigest,
    });
  }

  async renameCredential(
    tenant: TenantContext,
    targetCredentialId: unknown,
    name: unknown,
    requestId: string,
    actorDigest: string,
  ) {
    return this.repository.renameCredential({
      tenant,
      targetCredentialId: requireUuid(targetCredentialId, "连接标识"),
      name: normalizeName(name),
      requestId,
      actorDigest,
    });
  }

  private parseAuthorization(value: unknown) {
    if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
    return parseAgentToken(value.slice(7));
  }
}
