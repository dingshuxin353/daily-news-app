import type { QueryResultRow } from "pg";
import type { CloudFileConfig } from "../../cloud/config.js";
import { IdentityPublicError, keyedDigest } from "../../modules/identity/security.js";
import type { PostgresPool } from "./pool.js";

export interface LoginDeliveryReservation {
  id: string;
  emailHash: string;
}

interface LimitCountsRow extends QueryResultRow {
  email_cooldown: number;
  email_hour: number;
  ip_hour: number;
  global_day: number;
}

export class PostgresLoginRateLimiter {
  constructor(
    private readonly pool: PostgresPool,
    private readonly options: {
      digestSecret: string;
      limits: Pick<
        CloudFileConfig["limits"],
        "emailCooldownSeconds" | "emailHourlyLimit" | "ipHourlyLimit" | "testDailyEmailHardLimit"
      >;
      now?: () => Date;
    },
  ) {}

  async reserve(input: { email: string; ip: string }): Promise<LoginDeliveryReservation> {
    const emailHash = keyedDigest(this.options.digestSecret, input.email);
    const ipHash = keyedDigest(this.options.digestSecret, input.ip);
    const now = (this.options.now ?? (() => new Date()))();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const keys = [
        `email:${emailHash}`,
        `global:${now.toISOString().slice(0, 10)}`,
        `ip:${ipHash}`,
      ].sort();
      for (const key of keys) {
        await client.query(
          "INSERT INTO app.login_rate_locks (key) VALUES ($1) ON CONFLICT DO NOTHING",
          [key],
        );
        await client.query("SELECT key FROM app.login_rate_locks WHERE key = $1 FOR UPDATE", [key]);
      }

      const counts = await client.query<LimitCountsRow>(
        `SELECT
           count(*) FILTER (
             WHERE email_hash = $1
               AND created_at > $3::timestamptz - ($4::integer * interval '1 second')
           )::integer AS email_cooldown,
           count(*) FILTER (
             WHERE email_hash = $1
               AND created_at > $3::timestamptz - interval '1 hour'
           )::integer AS email_hour,
           count(*) FILTER (
             WHERE ip_hash = $2
               AND created_at > $3::timestamptz - interval '1 hour'
           )::integer AS ip_hour,
           count(*) FILTER (
             WHERE created_at >= date_trunc('day', $3::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           )::integer AS global_day
         FROM app.login_send_attempts`,
        [emailHash, ipHash, now, this.options.limits.emailCooldownSeconds],
      );
      const row = counts.rows[0];
      if (
        row.email_cooldown >= 1
        || row.email_hour >= this.options.limits.emailHourlyLimit
        || row.ip_hour >= this.options.limits.ipHourlyLimit
        || row.global_day >= this.options.limits.testDailyEmailHardLimit
      ) {
        throw new IdentityPublicError(429, "rate_limited");
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO app.login_send_attempts (email_hash, ip_hash)
         VALUES ($1, $2)
         RETURNING id::text AS id`,
        [emailHash, ipHash],
      );
      await client.query("COMMIT");
      return { id: inserted.rows[0].id, emailHash };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    reservation: LoginDeliveryReservation,
    result:
      | { status: "failed" }
      | { status: "sent"; requestId: string; messageId: string },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE app.login_send_attempts
         SET status = $2, completed_at = clock_timestamp()
         WHERE id = $1::uuid AND status = 'reserved'`,
        [reservation.id, result.status],
      );
      if (updated.rowCount !== 1) throw new Error("login delivery reservation was already completed");
      if (result.status === "sent") {
        await client.query(
          `INSERT INTO app.login_mail_deliveries
             (attempt_id, recipient_hash, provider_request_id, provider_message_id)
           VALUES ($1::uuid, $2, $3, $4)`,
          [reservation.id, reservation.emailHash, result.requestId, result.messageId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
