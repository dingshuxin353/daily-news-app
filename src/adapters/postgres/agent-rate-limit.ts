import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { PostgresPool } from "./pool.js";
import { requireTenantContext } from "./tenancy.js";
import type {
  AgentRequestAction,
  AgentRequestPolicyRepository,
} from "../../modules/agent-access/request-policy.js";
import { AgentRequestError } from "../../modules/agent-access/request-policy.js";

interface CountRow extends QueryResultRow {
  count: number;
}

function actionName(action: AgentRequestAction, dimension: "token" | "ip"): string {
  return `api_${action}_${dimension}`;
}

async function lockRateKey(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

export class PostgresAgentRequestPolicy implements AgentRequestPolicyRepository {
  constructor(private readonly pool: PostgresPool) {}

  async reserveRequest(input: Parameters<AgentRequestPolicyRepository["reserveRequest"]>[0]): Promise<void> {
    const tokenAction = actionName(input.action, "token");
    const ipAction = actionName(input.action, "ip");
    const lockKeys = [`${tokenAction}:${input.tokenDigest}`, `${ipAction}:${input.ipDigest}`].sort();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const key of lockKeys) await lockRateKey(client, key);
      await client.query(
        "DELETE FROM app.agent_rate_limit_events WHERE created_at < clock_timestamp() - ($1 * interval '1 hour')",
        [input.limits.retentionHours],
      );
      const [tokenCount, ipCount] = await Promise.all([
        client.query<CountRow>(
          `SELECT count(*)::integer AS count FROM app.agent_rate_limit_events
           WHERE action = $1 AND key_digest = $2
             AND created_at >= clock_timestamp() - interval '1 hour'`,
          [tokenAction, input.tokenDigest],
        ),
        client.query<CountRow>(
          `SELECT count(*)::integer AS count FROM app.agent_rate_limit_events
           WHERE action = $1 AND key_digest = $2
             AND created_at >= clock_timestamp() - interval '1 hour'`,
          [ipAction, input.ipDigest],
        ),
      ]);
      if (
        (tokenCount.rows[0]?.count ?? 0) >= input.limits.tokenHourlyLimit
        || (ipCount.rows[0]?.count ?? 0) >= input.limits.ipHourlyLimit
      ) {
        throw new AgentRequestError(429, "rate_limited", "请求过于频繁，请稍后重试。", 3600);
      }
      await client.query(
        `INSERT INTO app.agent_rate_limit_events (key_digest, action)
         VALUES ($1, $2), ($3, $4)`,
        [input.tokenDigest, tokenAction, input.ipDigest, ipAction],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof AgentRequestError) throw error;
      throw new AgentRequestError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
    } finally {
      client.release();
    }
  }

  async touchCredentialLastUsed(credentialId: string, minimumIntervalSeconds: number): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE app.agent_credentials
         SET last_used_at = clock_timestamp()
         WHERE id = $1 AND status = 'active'
           AND (last_used_at IS NULL OR last_used_at < clock_timestamp() - ($2 * interval '1 second'))`,
        [credentialId, minimumIntervalSeconds],
      );
    } catch {
      throw new AgentRequestError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
    }
  }

  async withWriteLease<T>(
    input: Parameters<AgentRequestPolicyRepository["withWriteLease"]>[0],
    work: () => Promise<T>,
  ): Promise<T> {
    requireTenantContext(input.tenant);
    const leaseId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM app.spaces WHERE id = $1 FOR UPDATE", [input.tenant.spaceId]);
      const credential = await client.query(
        `SELECT id FROM app.agent_credentials
         WHERE id = $1 AND space_id = $2 AND status = 'active' FOR UPDATE`,
        [input.credentialId, input.tenant.spaceId],
      );
      if (credential.rowCount !== 1) {
        throw new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
      }
      await client.query(
        "DELETE FROM app.agent_write_leases WHERE expires_at <= clock_timestamp()",
      );
      const count = await client.query<CountRow>(
        "SELECT count(*)::integer AS count FROM app.agent_write_leases WHERE space_id = $1",
        [input.tenant.spaceId],
      );
      if ((count.rows[0]?.count ?? 0) >= input.concurrentLimit) {
        throw new AgentRequestError(429, "rate_limited", "当前写入请求较多，请稍后重试。", 5);
      }
      await client.query(
        `INSERT INTO app.agent_write_leases
           (id, space_id, credential_id, request_id, expires_at)
         VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 * interval '1 second'))`,
        [leaseId, input.tenant.spaceId, input.credentialId, input.requestId, input.ttlSeconds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      if (error instanceof AgentRequestError) throw error;
      throw new AgentRequestError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
    }
    client.release();

    try {
      return await work();
    } finally {
      await this.pool.query("DELETE FROM app.agent_write_leases WHERE id = $1", [leaseId]).catch(() => {});
    }
  }
}
