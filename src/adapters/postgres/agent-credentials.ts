import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { PostgresPool } from "./pool.js";
import { requireTenantContext } from "./tenancy.js";
import type {
  AgentAccessRepository,
  CredentialIssueInput,
  CredentialRecord,
  CredentialRenameInput,
  CredentialRevokeInput,
  CredentialRotateInput,
  PairingClaimInput,
  PairingCreateInput,
  PairingRecord,
  PairingRefreshInput,
  PairingVerifyInput,
  VerifiedPairingContext,
} from "../../modules/agent-access/credential-service.js";
import { AgentAccessError } from "../../modules/agent-access/credential-service.js";

interface PairingRow extends QueryResultRow {
  id: string;
  space_id: string;
  intended_name: string;
  purpose: PairingRecord["purpose"];
  status: PairingRecord["status"];
  code_generation: number;
  expires_at: Date;
  claim_started_at: Date | null;
  provisioning_credential_id: string | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  creation_payload_hash?: string;
}

interface CredentialRow extends QueryResultRow {
  id: string;
  space_id: string;
  name: string;
  selector: string;
  secret_digest: string;
  token_hint: string;
  status: CredentialRecord["status"];
  rotated_from_id: string | null;
  expires_at: Date | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  issue_payload_hash?: string;
}

const PAIRING_COLUMNS = `id, space_id, intended_name, purpose, status, code_generation,
  expires_at, claim_started_at, provisioning_credential_id, verified_at, created_at, updated_at`;
const CREDENTIAL_COLUMNS = `id, space_id, name, selector, secret_digest, token_hint, status,
  rotated_from_id, expires_at, created_at, last_used_at, revoked_at`;

function mapPairing(row: PairingRow): PairingRecord {
  return {
    id: row.id,
    spaceId: row.space_id,
    intendedName: row.intended_name,
    purpose: row.purpose,
    status: row.status,
    codeGeneration: row.code_generation,
    expiresAt: row.expires_at,
    claimStartedAt: row.claim_started_at,
    provisioningCredentialId: row.provisioning_credential_id,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCredential(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    selector: row.selector,
    secretDigest: row.secret_digest,
    tokenHint: row.token_hint,
    status: row.status,
    rotatedFromId: row.rotated_from_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

async function lockSpace(client: PoolClient, spaceId: string): Promise<void> {
  const result = await client.query("SELECT id FROM app.spaces WHERE id = $1 FOR UPDATE", [spaceId]);
  if (result.rowCount !== 1) throw new AgentAccessError(404, "target_not_found", "没有找到目标空间。");
}

async function countOccupiedSlots(client: PoolClient, spaceId: string): Promise<number> {
  const result = await client.query<{ count: number } & QueryResultRow>(
    `SELECT (
       (SELECT count(*) FROM app.agent_credentials
        WHERE space_id = $1 AND status IN ('provisioning', 'active'))
       +
       (SELECT count(*) FROM app.agent_pairing_sessions
        WHERE space_id = $1 AND status = 'pending')
     )::integer AS count`,
    [spaceId],
  );
  return result.rows[0]?.count ?? 0;
}

async function enforceAvailableSlot(client: PoolClient, spaceId: string, limit: number): Promise<void> {
  if (await countOccupiedSlots(client, spaceId) >= limit) {
    throw new AgentAccessError(409, "credential_limit_reached", "Agent 授权数量已达到上限。");
  }
}

async function insertAudit(
  client: PoolClient,
  retentionDays: number,
  input: {
    spaceId: string | null;
    actorDigest: string;
    eventType: string;
    targetType: string;
    targetId?: string | null;
    result: string;
    requestId: string;
  },
): Promise<void> {
  await client.query(
    "DELETE FROM app.audit_events WHERE created_at < clock_timestamp() - ($1 * interval '1 day')",
    [retentionDays],
  );
  await client.query(
    `INSERT INTO app.audit_events
       (id, space_id, actor_digest, event_type, target_type, target_id, result, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), input.spaceId, input.actorDigest, input.eventType, input.targetType,
      input.targetId ?? null, input.result, input.requestId],
  );
}

async function reserveRateLimit(
  client: PoolClient,
  action: "pairing_claim" | "pairing_verify",
  keyDigest: string,
  limit: number,
  retentionHours: number,
): Promise<boolean> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${action}:${keyDigest}`]);
  await client.query(
    "DELETE FROM app.agent_rate_limit_events WHERE created_at < clock_timestamp() - ($1 * interval '1 hour')",
    [retentionHours],
  );
  await client.query(
    `DELETE FROM app.agent_rate_limit_events
     WHERE action = $1 AND key_digest = $2 AND created_at < clock_timestamp() - interval '1 hour'`,
    [action, keyDigest],
  );
  const count = await client.query<{ count: number } & QueryResultRow>(
    `SELECT count(*)::integer AS count
     FROM app.agent_rate_limit_events
     WHERE action = $1 AND key_digest = $2
       AND created_at >= clock_timestamp() - interval '1 hour'`,
    [action, keyDigest],
  );
  if ((count.rows[0]?.count ?? 0) >= limit) return false;
  await client.query(
    "INSERT INTO app.agent_rate_limit_events (key_digest, action) VALUES ($1, $2)",
    [keyDigest, action],
  );
  return true;
}

export class PostgresAgentAccessRepository implements AgentAccessRepository {
  constructor(
    private readonly pool: PostgresPool,
    private readonly retention: { rateLimitHours: number; auditDays: number },
  ) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof AgentAccessError) throw error;
      throw new AgentAccessError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
    } finally {
      client.release();
    }
  }

  async reservePairingRequest(
    action: "pairing_claim" | "pairing_verify",
    ipDigest: string,
    limit: number,
  ): Promise<void> {
    const allowed = await this.transaction((client) => reserveRateLimit(
      client,
      action,
      ipDigest,
      limit,
      this.retention.rateLimitHours,
    ));
    if (!allowed) throw new AgentAccessError(429, "rate_limited", "请求过于频繁，请稍后重试。", 3600);
  }

  async ensureBootstrapPairing(input: PairingCreateInput): Promise<PairingRecord> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      await lockSpace(client, input.tenant.spaceId);
      const existing = await client.query<PairingRow>(
        `SELECT ${PAIRING_COLUMNS}
         FROM app.agent_pairing_sessions
         WHERE space_id = $1 AND purpose = 'bootstrap'
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
        [input.tenant.spaceId],
      );
      if (existing.rows[0]) return mapPairing(existing.rows[0]);
      await enforceAvailableSlot(client, input.tenant.spaceId, input.activeCredentialLimit);
      const inserted = await this.insertPairing(client, input);
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId, actorDigest: input.actorDigest,
        eventType: "pairing_bootstrap_created", targetType: "pairing", targetId: inserted.id,
        result: "created", requestId: input.requestId,
      });
      return inserted;
    });
  }

  async createPairing(input: PairingCreateInput): Promise<{ record: PairingRecord; repeated: boolean }> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      await lockSpace(client, input.tenant.spaceId);
      const existing = await client.query<PairingRow>(
        `SELECT ${PAIRING_COLUMNS}, creation_payload_hash
         FROM app.agent_pairing_sessions
         WHERE space_id = $1 AND creation_operation_id = $2 FOR UPDATE`,
        [input.tenant.spaceId, input.operationId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].creation_payload_hash !== input.payloadHash) {
          throw new AgentAccessError(409, "operation_conflict", "这个操作标识已经用于另一项请求。");
        }
        return { record: mapPairing(existing.rows[0]), repeated: true };
      }
      await enforceAvailableSlot(client, input.tenant.spaceId, input.activeCredentialLimit);
      const record = await this.insertPairing(client, input);
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId, actorDigest: input.actorDigest,
        eventType: "pairing_created", targetType: "pairing", targetId: record.id,
        result: "created", requestId: input.requestId,
      });
      return { record, repeated: false };
    });
  }

  private async insertPairing(client: PoolClient, input: PairingCreateInput): Promise<PairingRecord> {
    const result = await client.query<PairingRow>(
      `INSERT INTO app.agent_pairing_sessions
         (id, space_id, intended_name, purpose, creation_operation_id,
          creation_payload_hash, status, code_generation, code_digest, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 1, $7, $8)
       RETURNING ${PAIRING_COLUMNS}`,
      [input.id, input.tenant.spaceId, input.intendedName, input.purpose, input.operationId,
        input.payloadHash, input.codeDigest, input.expiresAt],
    );
    return mapPairing(result.rows[0]);
  }

  async getPairing(tenant: PairingCreateInput["tenant"], pairingId: string): Promise<PairingRecord | null> {
    requireTenantContext(tenant);
    const result = await this.pool.query<PairingRow>(
      `SELECT ${PAIRING_COLUMNS} FROM app.agent_pairing_sessions WHERE id = $1 AND space_id = $2`,
      [pairingId, tenant.spaceId],
    );
    return result.rows[0] ? mapPairing(result.rows[0]) : null;
  }

  async listPairings(tenant: PairingCreateInput["tenant"]): Promise<PairingRecord[]> {
    requireTenantContext(tenant);
    const result = await this.pool.query<PairingRow>(
      `SELECT ${PAIRING_COLUMNS} FROM app.agent_pairing_sessions
       WHERE space_id = $1 ORDER BY created_at DESC`,
      [tenant.spaceId],
    );
    return result.rows.map(mapPairing);
  }

  async refreshPairing(input: PairingRefreshInput): Promise<PairingRecord> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      const result = await client.query<PairingRow>(
        `UPDATE app.agent_pairing_sessions
         SET status = 'pending', code_generation = $3, code_digest = $4, expires_at = $5,
             claim_started_at = NULL, provisioning_credential_id = NULL, updated_at = clock_timestamp()
         WHERE id = $1 AND space_id = $2 AND status IN ('pending', 'expired') AND code_generation = $3 - 1
         RETURNING ${PAIRING_COLUMNS}`,
        [input.pairingId, input.tenant.spaceId, input.codeGeneration, input.codeDigest, input.expiresAt],
      );
      const record = result.rows[0];
      if (!record) throw new AgentAccessError(409, "pairing_unavailable", "配对码已经变化，请刷新后重试。");
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId, actorDigest: input.actorDigest,
        eventType: "pairing_refreshed", targetType: "pairing", targetId: input.pairingId,
        result: "updated", requestId: input.requestId,
      });
      return mapPairing(record);
    });
  }

  async cancelClaimAndRefresh(input: PairingRefreshInput): Promise<PairingRecord> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      const pairingResult = await client.query<PairingRow>(
        `SELECT ${PAIRING_COLUMNS} FROM app.agent_pairing_sessions
         WHERE id = $1 AND space_id = $2 FOR UPDATE`,
        [input.pairingId, input.tenant.spaceId],
      );
      const pairing = pairingResult.rows[0];
      if (!pairing || pairing.status !== "claimed" || !pairing.provisioning_credential_id) {
        throw new AgentAccessError(409, "pairing_unavailable", "这条连接当前不能取消。");
      }
      await client.query(
        `UPDATE app.agent_credentials SET status = 'revoked', revoked_at = clock_timestamp()
         WHERE id = $1 AND space_id = $2 AND status = 'provisioning'`,
        [pairing.provisioning_credential_id, input.tenant.spaceId],
      );
      const refreshed = await client.query<PairingRow>(
        `UPDATE app.agent_pairing_sessions
         SET status = 'pending', code_generation = $3, code_digest = $4, expires_at = $5,
             claim_started_at = NULL, provisioning_credential_id = NULL, updated_at = clock_timestamp()
         WHERE id = $1 AND space_id = $2 AND status = 'claimed'
         RETURNING ${PAIRING_COLUMNS}`,
        [input.pairingId, input.tenant.spaceId, input.codeGeneration, input.codeDigest, input.expiresAt],
      );
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId, actorDigest: input.actorDigest,
        eventType: "pairing_claim_cancelled", targetType: "pairing", targetId: input.pairingId,
        result: "revoked_and_refreshed", requestId: input.requestId,
      });
      return mapPairing(refreshed.rows[0]);
    });
  }

  async claimPairing(input: PairingClaimInput): Promise<{ pairing: PairingRecord; credential: CredentialRecord }> {
    const outcome = await this.transaction(async (client) => {
      const pairingResult = await client.query<PairingRow>(
        `SELECT ${PAIRING_COLUMNS} FROM app.agent_pairing_sessions
         WHERE code_digest = $1 AND status = 'pending' FOR UPDATE`,
        [input.codeDigest],
      );
      const pairing = pairingResult.rows[0];
      if (!pairing) {
        await insertAudit(client, this.retention.auditDays, {
          spaceId: null, actorDigest: input.ipDigest, eventType: "pairing_claim_failed",
          targetType: "pairing", result: "invalid", requestId: input.requestId,
        });
        return { error: new AgentAccessError(404, "pairing_unavailable", "配对码无效或已更新。") } as const;
      }
      if (pairing.expires_at.getTime() <= Date.now()) {
        await client.query(
          `UPDATE app.agent_pairing_sessions SET status = 'expired', updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'pending'`,
          [pairing.id],
        );
        await insertAudit(client, this.retention.auditDays, {
          spaceId: pairing.space_id, actorDigest: input.ipDigest, eventType: "pairing_claim_failed",
          targetType: "pairing", targetId: pairing.id, result: "expired", requestId: input.requestId,
        });
        return { error: new AgentAccessError(404, "pairing_unavailable", "配对码无效或已更新。") } as const;
      }
      await lockSpace(client, pairing.space_id);
      if (await countOccupiedSlots(client, pairing.space_id) > input.activeCredentialLimit) {
        throw new AgentAccessError(409, "credential_limit_reached", "Agent 授权数量已达到上限。");
      }
      const credentialResult = await client.query<CredentialRow>(
        `INSERT INTO app.agent_credentials
           (id, space_id, name, selector, secret_digest, token_hint, issue_operation_id,
            issue_payload_hash, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'provisioning', $9)
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [input.credentialId, pairing.space_id, input.clientName, input.selector, input.secretDigest,
          input.tokenHint, input.operationId, input.payloadHash, input.expiresAt],
      );
      const claimed = await client.query<PairingRow>(
        `UPDATE app.agent_pairing_sessions
         SET status = 'claimed', claim_started_at = clock_timestamp(),
             provisioning_credential_id = $2, updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'pending' RETURNING ${PAIRING_COLUMNS}`,
        [pairing.id, input.credentialId],
      );
      await insertAudit(client, this.retention.auditDays, {
        spaceId: pairing.space_id, actorDigest: input.ipDigest,
        eventType: "pairing_claimed", targetType: "pairing", targetId: pairing.id,
        result: "provisioning", requestId: input.requestId,
      });
      return { value: { pairing: mapPairing(claimed.rows[0]), credential: mapCredential(credentialResult.rows[0]) } } as const;
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  async verifyPairing(input: PairingVerifyInput): Promise<{ context: VerifiedPairingContext; credential: CredentialRecord }> {
    const outcome = await this.transaction(async (client) => {
      const credentialResult = await client.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM app.agent_credentials
         WHERE id = $1 AND selector = $2 FOR UPDATE`,
        [input.credentialId, input.selector],
      );
      const credential = credentialResult.rows[0];
      if (!input.authorizationValid || !credential || credential.status !== "provisioning") {
        await insertAudit(client, this.retention.auditDays, {
          spaceId: credential?.space_id ?? null, actorDigest: input.actorDigest,
          eventType: "pairing_verify_failed", targetType: "credential",
          targetId: credential?.id, result: "invalid", requestId: input.requestId,
        });
        return { error: new AgentAccessError(401, "authentication_failed", "连接密钥无效或已失效。") } as const;
      }
      const pairingResult = await client.query<PairingRow>(
        `SELECT ${PAIRING_COLUMNS} FROM app.agent_pairing_sessions
         WHERE provisioning_credential_id = $1 AND status = 'claimed' FOR UPDATE`,
        [credential.id],
      );
      const pairing = pairingResult.rows[0];
      if (!pairing || !credential.expires_at || credential.expires_at.getTime() <= Date.now()) {
        await client.query(
          `UPDATE app.agent_credentials SET status = 'revoked', revoked_at = clock_timestamp()
           WHERE id = $1 AND status = 'provisioning'`,
          [credential.id],
        );
        if (pairing) {
          await client.query(
            `UPDATE app.agent_pairing_sessions SET status = 'expired', updated_at = clock_timestamp()
             WHERE id = $1 AND status = 'claimed'`,
            [pairing.id],
          );
        }
        await insertAudit(client, this.retention.auditDays, {
          spaceId: credential.space_id, actorDigest: input.actorDigest,
          eventType: "pairing_verify_failed", targetType: "credential",
          targetId: credential.id, result: "expired", requestId: input.requestId,
        });
        return { error: new AgentAccessError(401, "authentication_failed", "连接密钥无效或已失效。") } as const;
      }
      const activated = await client.query<CredentialRow>(
        `UPDATE app.agent_credentials
         SET status = 'active', expires_at = NULL, last_used_at = clock_timestamp()
         WHERE id = $1 AND status = 'provisioning' RETURNING ${CREDENTIAL_COLUMNS}`,
        [credential.id],
      );
      await client.query(
        `UPDATE app.agent_pairing_sessions
         SET status = 'verified', verified_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'claimed'`,
        [pairing.id],
      );
      const contextResult = await client.query<VerifiedPairingContext & QueryResultRow>(
        `SELECT p.publication_id AS "publicationId", p.display_name AS "publicationName",
                pc.time_zone AS "timeZone", tp.enabled AS "todoEnabled"
         FROM app.publications p
         JOIN app.publication_configs pc
           ON pc.space_id = p.space_id AND pc.publication_id = p.publication_id
         JOIN app.todo_profiles tp ON tp.space_id = p.space_id
         WHERE p.space_id = $1 AND p.is_default`,
        [credential.space_id],
      );
      const context = contextResult.rows[0];
      if (!context) throw new AgentAccessError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
      await insertAudit(client, this.retention.auditDays, {
        spaceId: credential.space_id, actorDigest: input.actorDigest,
        eventType: "pairing_verified", targetType: "credential", targetId: credential.id,
        result: "active", requestId: input.requestId,
      });
      return { value: { context, credential: mapCredential(activated.rows[0]) } } as const;
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  async listCredentials(tenant: PairingCreateInput["tenant"]): Promise<CredentialRecord[]> {
    requireTenantContext(tenant);
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM app.agent_credentials
       WHERE space_id = $1 ORDER BY created_at DESC`,
      [tenant.spaceId],
    );
    return result.rows.map(mapCredential);
  }

  async issueManualCredential(input: CredentialIssueInput): Promise<{ credential: CredentialRecord; repeated: boolean }> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      await lockSpace(client, input.tenant.spaceId);
      const repeated = await this.findOperationCredential(client, input.tenant.spaceId, input.operationId, input.payloadHash);
      if (repeated) return { credential: repeated, repeated: true };
      await enforceAvailableSlot(client, input.tenant.spaceId, input.activeCredentialLimit);
      const credential = await this.insertActiveCredential(client, input, null);
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId, actorDigest: input.actorDigest,
        eventType: "credential_created", targetType: "credential", targetId: credential.id,
        result: "active", requestId: input.requestId,
      });
      return { credential, repeated: false };
    });
  }

  async rotateCredential(input: CredentialRotateInput): Promise<{ credential: CredentialRecord; repeated: boolean }> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      await lockSpace(client, input.tenant.spaceId);
      const repeated = await this.findOperationCredential(client, input.tenant.spaceId, input.operationId, input.payloadHash);
      if (repeated) return { credential: repeated, repeated: true };
      const targetResult = await client.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM app.agent_credentials
         WHERE id = $1 AND space_id = $2 FOR UPDATE`,
        [input.targetCredentialId, input.tenant.spaceId],
      );
      const target = targetResult.rows[0];
      if (!target || target.status !== "active") {
        throw new AgentAccessError(404, "target_not_found", "没有找到可轮换的连接密钥。");
      }
      const credential = await this.insertActiveCredential(client, input, target.id);
      await client.query(
        `UPDATE app.agent_credentials SET status = 'rotated', revoked_at = clock_timestamp()
         WHERE id = $1 AND status = 'active'`,
        [target.id],
      );
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId, actorDigest: input.actorDigest,
        eventType: "credential_rotated", targetType: "credential", targetId: target.id,
        result: "rotated", requestId: input.requestId,
      });
      return { credential, repeated: false };
    });
  }

  private async findOperationCredential(
    client: PoolClient, spaceId: string, operationId: string, payloadHash: string,
  ): Promise<CredentialRecord | null> {
    const result = await client.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS}, issue_payload_hash FROM app.agent_credentials
       WHERE space_id = $1 AND issue_operation_id = $2 FOR UPDATE`,
      [spaceId, operationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.issue_payload_hash !== payloadHash) {
      throw new AgentAccessError(409, "operation_conflict", "这个操作标识已经用于另一项请求。");
    }
    return mapCredential(row);
  }

  private async insertActiveCredential(
    client: PoolClient, input: CredentialIssueInput, rotatedFromId: string | null,
  ): Promise<CredentialRecord> {
    const result = await client.query<CredentialRow>(
      `INSERT INTO app.agent_credentials
         (id, space_id, name, selector, secret_digest, token_hint, issue_operation_id,
          issue_payload_hash, status, rotated_from_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
       RETURNING ${CREDENTIAL_COLUMNS}`,
      [input.credentialId, input.tenant.spaceId, input.name, input.selector, input.secretDigest,
        input.tokenHint, input.operationId, input.payloadHash, rotatedFromId],
    );
    return mapCredential(result.rows[0]);
  }

  async revokeCredential(input: CredentialRevokeInput): Promise<CredentialRecord> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      await lockSpace(client, input.tenant.spaceId);
      const result = await client.query<CredentialRow>(
        `UPDATE app.agent_credentials SET status = 'revoked', revoked_at = clock_timestamp()
         WHERE id = $1 AND space_id = $2 AND status IN ('active', 'provisioning')
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [input.targetCredentialId, input.tenant.spaceId],
      );
      const credential = result.rows[0];
      if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可移除的 Agent 授权。");
      await client.query(
        `UPDATE app.agent_pairing_sessions SET status = 'cancelled', updated_at = clock_timestamp()
         WHERE provisioning_credential_id = $1 AND status = 'claimed'`,
        [credential.id],
      );
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId, actorDigest: input.actorDigest,
        eventType: "credential_revoked", targetType: "credential", targetId: credential.id,
        result: "revoked", requestId: input.requestId,
      });
      return mapCredential(credential);
    });
  }

  async renameCredential(input: CredentialRenameInput): Promise<CredentialRecord> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      const result = await client.query<CredentialRow>(
        `UPDATE app.agent_credentials SET name = $3
         WHERE id = $1 AND space_id = $2 AND status = 'active'
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [input.targetCredentialId, input.tenant.spaceId, input.name],
      );
      const credential = result.rows[0];
      if (!credential) throw new AgentAccessError(404, "target_not_found", "没有找到可修改的 Agent 授权。");
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId, actorDigest: input.actorDigest,
        eventType: "credential_renamed", targetType: "credential", targetId: credential.id,
        result: "updated", requestId: input.requestId,
      });
      return mapCredential(credential);
    });
  }

  async findCredentialBySelector(selector: string): Promise<CredentialRecord | null> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM app.agent_credentials WHERE selector = $1`,
      [selector],
    );
    return result.rows[0] ? mapCredential(result.rows[0]) : null;
  }
}
