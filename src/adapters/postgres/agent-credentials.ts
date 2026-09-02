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
} from "../../modules/agent-access/credential-service.js";
import { AgentAccessError } from "../../modules/agent-access/credential-service.js";

interface CredentialRow extends QueryResultRow {
  id: string;
  space_id: string;
  name: string;
  selector: string;
  secret_digest: string;
  token_hint: string;
  status: CredentialRecord["status"];
  rotated_from_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  issue_payload_hash?: string;
}

const CREDENTIAL_COLUMNS = `id, space_id, name, selector, secret_digest, token_hint, status,
  rotated_from_id, created_at, last_used_at, revoked_at`;

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
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

async function lockSpace(client: PoolClient, spaceId: string): Promise<void> {
  const result = await client.query("SELECT id FROM app.spaces WHERE id = $1 FOR UPDATE", [spaceId]);
  if (result.rowCount !== 1) throw new AgentAccessError(404, "target_not_found", "找不到目标空间。");
}

async function enforceAvailableSlot(client: PoolClient, spaceId: string, limit: number): Promise<void> {
  const result = await client.query<{ count: number } & QueryResultRow>(
    "SELECT count(*)::integer AS count FROM app.agent_credentials WHERE space_id = $1 AND status = 'active'",
    [spaceId],
  );
  if ((result.rows[0]?.count ?? 0) >= limit) {
    throw new AgentAccessError(409, "credential_limit_reached", "Agent Token 数量已达到上限。");
  }
}

async function insertAudit(
  client: PoolClient,
  retentionDays: number,
  input: {
    spaceId: string;
    actorDigest: string;
    eventType: string;
    targetId: string;
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
     VALUES ($1, $2, $3, $4, 'credential', $5, $6, $7)`,
    [randomUUID(), input.spaceId, input.actorDigest, input.eventType, input.targetId, input.result, input.requestId],
  );
}

export class PostgresAgentAccessRepository implements AgentAccessRepository {
  constructor(
    private readonly pool: PostgresPool,
    private readonly retention: { auditDays: number },
  ) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof AgentAccessError) throw error;
      throw new AgentAccessError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
    } finally {
      client.release();
    }
  }

  async listCredentials(tenant: CredentialIssueInput["tenant"]): Promise<CredentialRecord[]> {
    requireTenantContext(tenant);
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM app.agent_credentials
       WHERE space_id = $1 ORDER BY created_at DESC`,
      [tenant.spaceId],
    );
    return result.rows.map(mapCredential);
  }

  async issueCredential(input: CredentialIssueInput): Promise<{ credential: CredentialRecord; repeated: boolean }> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      await lockSpace(client, input.tenant.spaceId);
      const repeated = await this.findOperationCredential(client, input.tenant.spaceId, input.operationId, input.payloadHash);
      if (repeated) return { credential: repeated, repeated: true };
      await enforceAvailableSlot(client, input.tenant.spaceId, input.activeCredentialLimit);
      const credential = await this.insertActiveCredential(client, input, null);
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId,
        actorDigest: input.actorDigest,
        eventType: "credential_created",
        targetId: credential.id,
        result: "active",
        requestId: input.requestId,
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
        throw new AgentAccessError(404, "target_not_found", "找不到可轮换的 Agent Token。");
      }
      const credential = await this.insertActiveCredential(client, input, target.id);
      await client.query(
        `UPDATE app.agent_credentials SET status = 'rotated', revoked_at = clock_timestamp()
         WHERE id = $1 AND status = 'active'`,
        [target.id],
      );
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId,
        actorDigest: input.actorDigest,
        eventType: "credential_rotated",
        targetId: target.id,
        result: "rotated",
        requestId: input.requestId,
      });
      return { credential, repeated: false };
    });
  }

  private async findOperationCredential(
    client: PoolClient,
    spaceId: string,
    operationId: string,
    payloadHash: string,
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
    client: PoolClient,
    input: CredentialIssueInput,
    rotatedFromId: string | null,
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
         WHERE id = $1 AND space_id = $2 AND status = 'active'
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [input.targetCredentialId, input.tenant.spaceId],
      );
      const credential = result.rows[0];
      if (!credential) throw new AgentAccessError(404, "target_not_found", "找不到可撤销的 Agent Token。");
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId,
        actorDigest: input.actorDigest,
        eventType: "credential_revoked",
        targetId: credential.id,
        result: "revoked",
        requestId: input.requestId,
      });
      return mapCredential(credential);
    });
  }

  async renameCredential(input: CredentialRenameInput): Promise<CredentialRecord> {
    requireTenantContext(input.tenant);
    return this.transaction(async (client) => {
      await lockSpace(client, input.tenant.spaceId);
      const result = await client.query<CredentialRow>(
        `UPDATE app.agent_credentials SET name = $3
         WHERE id = $1 AND space_id = $2 AND status = 'active'
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [input.targetCredentialId, input.tenant.spaceId, input.name],
      );
      const credential = result.rows[0];
      if (!credential) throw new AgentAccessError(404, "target_not_found", "找不到可修改的 Agent Token。");
      await insertAudit(client, this.retention.auditDays, {
        spaceId: input.tenant.spaceId,
        actorDigest: input.actorDigest,
        eventType: "credential_renamed",
        targetId: credential.id,
        result: "updated",
        requestId: input.requestId,
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
