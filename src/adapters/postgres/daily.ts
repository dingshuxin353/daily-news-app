import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { PublicationContext } from "./tenancy.js";
import { requirePublicationContext } from "./tenancy.js";
import type { PostgresPool } from "./pool.js";

const CLIENT_RUN_ID = /^[A-Za-z0-9._-]{8,80}$/;
const ISSUE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DailyStorageErrorCode =
  | "DAILY_INPUT_INVALID"
  | "DAILY_IDEMPOTENCY_CONFLICT"
  | "DAILY_FUTURE_DATE_NOT_ALLOWED"
  | "DAILY_EXPLICIT_CONFIRMATION_REQUIRED"
  | "DAILY_REVISION_CONFLICT"
  | "DAILY_PUBLICATION_INACTIVE"
  | "DAILY_INVALID_TOKEN"
  | "DAILY_STORAGE_FAILED";

export class DailyStorageError extends Error {
  constructor(
    readonly code: DailyStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DailyStorageError";
  }
}

export interface PriorityLimits {
  lead: number;
  important: number;
  normal: number | null;
}

export interface DailyWriteTransaction {
  readIssue(): Promise<unknown | null>;
  readCompiled(): Promise<unknown | null>;
  readIndex(): Promise<unknown | null>;
  listIssueDates(): Promise<string[]>;
  commit(changes: Record<string, unknown>): Promise<void>;
}

export interface DailyApplicationStorage {
  withWriteTransaction<T>(
    date: string,
    work: (transaction: DailyWriteTransaction) => Promise<T>,
  ): Promise<T>;
}

interface JsonRow extends QueryResultRow {
  payload: unknown;
}

interface DateRow extends QueryResultRow {
  issue_date: string;
}

interface SubmissionRow extends QueryResultRow {
  payload_hash: string;
  result_payload: unknown;
}

interface ConfigRow extends QueryResultRow {
  priority_limits: PriorityLimits;
}

interface RevisionRow extends QueryResultRow {
  revision: number;
}

interface PublicationStatusRow extends QueryResultRow {
  status: "active" | "inactive";
}

export interface DailyWritePolicy {
  today: string;
  activeCredentialId?: string;
  historicalDate: string | null;
  replace: {
    publicationId: string;
    date: string;
    expectedRevision: number;
  } | null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DailyStorageError("DAILY_INPUT_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireDate(value: unknown): string {
  if (typeof value !== "string" || !ISSUE_DATE.test(value)) {
    throw new DailyStorageError("DAILY_INPUT_INVALID", "candidate date is invalid");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DailyStorageError("DAILY_INPUT_INVALID", "candidate date is invalid");
  }
  return value;
}

function requireRevision(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new DailyStorageError("DAILY_INPUT_INVALID", `${label} revision is invalid`);
  }
  return value as number;
}

function requireMode(value: unknown): "update" | "replace" {
  const mode = value ?? "update";
  if (mode !== "update" && mode !== "replace") {
    throw new DailyStorageError("DAILY_INPUT_INVALID", "daily mode is invalid");
  }
  return mode;
}

async function listDates(client: PoolClient, context: PublicationContext): Promise<string[]> {
  const result = await client.query<DateRow>(
    `SELECT issue_date::text AS issue_date
     FROM app.issues
     WHERE space_id = $1 AND publication_id = $2
     ORDER BY issue_date DESC`,
    [context.tenant.spaceId, context.publicationId],
  );
  return result.rows.map(({ issue_date }) => issue_date);
}

async function readPriorityLimits(client: PoolClient, context: PublicationContext): Promise<PriorityLimits> {
  const result = await client.query<ConfigRow>(
    `SELECT priority_limits
     FROM app.publication_configs
     WHERE space_id = $1 AND publication_id = $2`,
    [context.tenant.spaceId, context.publicationId],
  );
  if (!result.rows[0]) {
    throw new DailyStorageError("DAILY_STORAGE_FAILED", "publication configuration is unavailable");
  }
  return result.rows[0].priority_limits;
}

function createApplicationStorage(
  client: PoolClient,
  context: PublicationContext,
  lockedDate: string,
): DailyApplicationStorage {
  let entered = false;
  return Object.freeze({
    async withWriteTransaction<T>(
      requestedDate: string,
      work: (transaction: DailyWriteTransaction) => Promise<T>,
    ): Promise<T> {
      if (entered || requestedDate !== lockedDate) {
        throw new DailyStorageError("DAILY_STORAGE_FAILED", "daily transaction context is invalid");
      }
      entered = true;
      const transaction: DailyWriteTransaction = {
        async readIssue() {
          const result = await client.query<JsonRow>(
            `SELECT issue_payload AS payload
             FROM app.issues
             WHERE space_id = $1 AND publication_id = $2 AND issue_date = $3::date`,
            [context.tenant.spaceId, context.publicationId, lockedDate],
          );
          return result.rows[0]?.payload ?? null;
        },
        async readCompiled() {
          const result = await client.query<JsonRow>(
            `SELECT compiled_payload AS payload
             FROM app.compiled_editions
             WHERE space_id = $1 AND publication_id = $2 AND issue_date = $3::date`,
            [context.tenant.spaceId, context.publicationId, lockedDate],
          );
          return result.rows[0]?.payload ?? null;
        },
        async readIndex() {
          const dates = await listDates(client, context);
          return dates.length === 0 ? null : { latest: dates[0], dates };
        },
        listIssueDates() {
          return listDates(client, context);
        },
        async commit(changes: Record<string, unknown>) {
          const issue = changes.issue;
          if (issue !== undefined) {
            const payload = requireRecord(issue, "issue");
            const date = requireDate(payload.date);
            if (date !== lockedDate) {
              throw new DailyStorageError("DAILY_INPUT_INVALID", "issue date does not match the locked date");
            }
            const revision = requireRevision(payload.revision, "issue");
            await client.query(
              `INSERT INTO app.issues
                 (space_id, publication_id, issue_date, revision, issue_payload)
               VALUES ($1, $2, $3::date, $4, $5::jsonb)
               ON CONFLICT (space_id, publication_id, issue_date) DO UPDATE
                 SET revision = EXCLUDED.revision,
                     issue_payload = EXCLUDED.issue_payload,
                     updated_at = clock_timestamp()`,
              [context.tenant.spaceId, context.publicationId, date, revision, JSON.stringify(payload)],
            );
          }

          const compiled = changes.compiled;
          if (compiled !== undefined) {
            const payload = requireRecord(compiled, "compiled edition");
            const date = requireDate(payload.date);
            if (date !== lockedDate) {
              throw new DailyStorageError("DAILY_INPUT_INVALID", "compiled date does not match the locked date");
            }
            const revision = requireRevision(payload.revision, "compiled edition");
            await client.query(
              `INSERT INTO app.compiled_editions
                 (space_id, publication_id, issue_date, revision, compiled_payload)
               VALUES ($1, $2, $3::date, $4, $5::jsonb)
               ON CONFLICT (space_id, publication_id, issue_date) DO UPDATE
                 SET revision = EXCLUDED.revision,
                     compiled_payload = EXCLUDED.compiled_payload,
                     updated_at = clock_timestamp()`,
              [context.tenant.spaceId, context.publicationId, date, revision, JSON.stringify(payload)],
            );
          }

          if (changes.index !== undefined) {
            const dates = await listDates(client, context);
            const expected = dates.length === 0 ? null : { latest: dates[0], dates };
            if (JSON.stringify(changes.index) !== JSON.stringify(expected)) {
              throw new DailyStorageError("DAILY_STORAGE_FAILED", "derived publication index is inconsistent");
            }
          }
        },
      };
      return work(transaction);
    },
  });
}

export class PostgresDailyStorage {
  constructor(
    private readonly pool: PostgresPool,
    private readonly context: PublicationContext,
    private readonly retention?: { submissionDays: number },
  ) {
    requirePublicationContext(context);
  }

  async runSubmission<T>(input: {
    clientRunId: string;
    date: string;
    mode?: "update" | "replace";
    payloadHash: string;
    candidate: unknown;
    writePolicy: DailyWritePolicy;
  }, work: (storage: DailyApplicationStorage, priorityLimits: PriorityLimits) => Promise<T>): Promise<T> {
    if (!CLIENT_RUN_ID.test(input.clientRunId)) {
      throw new DailyStorageError("DAILY_INPUT_INVALID", "clientRunId is invalid");
    }
    const date = requireDate(input.date);
    const mode = requireMode(input.mode);
    const candidate = requireRecord(input.candidate, "candidate");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (input.writePolicy.activeCredentialId) {
        await client.query(
          "SELECT id FROM app.spaces WHERE id = $1 FOR KEY SHARE",
          [this.context.tenant.spaceId],
        );
        const credential = await client.query(
          `SELECT id FROM app.agent_credentials
           WHERE id = $1 AND space_id = $2 AND status = 'active' FOR KEY SHARE`,
          [input.writePolicy.activeCredentialId, this.context.tenant.spaceId],
        );
        if (credential.rowCount !== 1) {
          throw new DailyStorageError("DAILY_INVALID_TOKEN", "Agent credential is no longer active");
        }
      }
      if (this.retention) {
        await client.query(
          `DELETE FROM app.daily_submission_runs
           WHERE space_id = $1 AND publication_id = $2
             AND processed_at < clock_timestamp() - ($3 * interval '1 day')`,
          [this.context.tenant.spaceId, this.context.publicationId, this.retention.submissionDays],
        );
        await client.query(
          `DELETE FROM app.daily_candidates c
           WHERE c.space_id = $1 AND c.publication_id = $2
             AND c.processed_at < clock_timestamp() - ($3 * interval '1 day')
             AND NOT EXISTS (
               SELECT 1 FROM app.daily_submission_runs r
               WHERE r.space_id = c.space_id AND r.publication_id = c.publication_id
                 AND r.candidate_id = c.id
             )`,
          [this.context.tenant.spaceId, this.context.publicationId, this.retention.submissionDays],
        );
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${this.context.tenant.spaceId}:${this.context.publicationId}:${input.clientRunId}`,
      ]);
      const existing = await client.query<SubmissionRow>(
        `SELECT payload_hash, result_payload
         FROM app.daily_submission_runs
         WHERE space_id = $1 AND publication_id = $2 AND client_run_id = $3`,
        [this.context.tenant.spaceId, this.context.publicationId, input.clientRunId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== input.payloadHash) {
          throw new DailyStorageError(
            "DAILY_IDEMPOTENCY_CONFLICT",
            "clientRunId was already used for different input",
          );
        }
        await client.query("COMMIT");
        return existing.rows[0].result_payload as T;
      }
      const publication = await client.query<PublicationStatusRow>(
        `SELECT status FROM app.publications
         WHERE space_id = $1 AND publication_id = $2
         FOR UPDATE`,
        [this.context.tenant.spaceId, this.context.publicationId],
      );
      if (publication.rows[0]?.status !== "active") {
        throw new DailyStorageError("DAILY_PUBLICATION_INACTIVE", "inactive Publications reject new submissions");
      }

      await client.query(
        `INSERT INTO app.publication_date_locks (space_id, publication_id, issue_date)
         VALUES ($1, $2, $3::date)
         ON CONFLICT (space_id, publication_id, issue_date) DO NOTHING`,
        [this.context.tenant.spaceId, this.context.publicationId, date],
      );
      await client.query(
        `SELECT 1
         FROM app.publication_date_locks
         WHERE space_id = $1 AND publication_id = $2 AND issue_date = $3::date
         FOR UPDATE`,
        [this.context.tenant.spaceId, this.context.publicationId, date],
      );

      const currentIssue = await client.query<RevisionRow>(
        `SELECT revision FROM app.issues
         WHERE space_id = $1 AND publication_id = $2 AND issue_date = $3::date`,
        [this.context.tenant.spaceId, this.context.publicationId, date],
      );
      const today = requireDate(input.writePolicy.today);
      if (date > today) {
        throw new DailyStorageError("DAILY_FUTURE_DATE_NOT_ALLOWED", "future Daily dates are not allowed");
      }
      if (date < today && input.writePolicy.historicalDate !== date) {
        throw new DailyStorageError(
          "DAILY_EXPLICIT_CONFIRMATION_REQUIRED",
          "historical Daily writes require confirmation",
        );
      }
      if (date === today && input.writePolicy.historicalDate !== null) {
        throw new DailyStorageError("DAILY_INPUT_INVALID", "historical confirmation does not match the target date");
      }
      if (mode === "update" && input.writePolicy.replace !== null) {
        throw new DailyStorageError("DAILY_INPUT_INVALID", "replace confirmation requires replace mode");
      }
      if (mode === "replace") {
        const confirmation = input.writePolicy.replace;
        const revision = currentIssue.rows[0]?.revision;
        if (
          !confirmation
          || confirmation.publicationId !== this.context.publicationId
          || confirmation.date !== date
          || revision === undefined
        ) {
          throw new DailyStorageError(
            "DAILY_EXPLICIT_CONFIRMATION_REQUIRED",
            "replace requires confirmation for an existing Daily issue",
          );
        }
        if (confirmation.expectedRevision !== revision) {
          throw new DailyStorageError("DAILY_REVISION_CONFLICT", "Daily issue revision changed after confirmation");
        }
      }

      const candidateId = randomUUID();
      await client.query(
        `INSERT INTO app.daily_candidates
           (id, space_id, publication_id, issue_date, client_run_id, mode, payload_hash, candidate_payload)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8::jsonb)`,
        [
          candidateId,
          this.context.tenant.spaceId,
          this.context.publicationId,
          date,
          input.clientRunId,
          mode,
          input.payloadHash,
          JSON.stringify(candidate),
        ],
      );
      const result = await work(
        createApplicationStorage(client, this.context, date),
        await readPriorityLimits(client, this.context),
      );
      requireRecord(result, "daily result");
      await client.query(
        `INSERT INTO app.daily_submission_runs
           (space_id, publication_id, client_run_id, candidate_id, payload_hash, result_payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          this.context.tenant.spaceId,
          this.context.publicationId,
          input.clientRunId,
          candidateId,
          input.payloadHash,
          JSON.stringify(result),
        ],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof DailyStorageError) throw error;
      throw new DailyStorageError("DAILY_STORAGE_FAILED", "daily submission failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async readIssue(date: string): Promise<unknown | null> {
    const result = await this.pool.query<JsonRow>(
      `SELECT issue_payload AS payload
       FROM app.issues
       WHERE space_id = $1 AND publication_id = $2 AND issue_date = $3::date`,
      [this.context.tenant.spaceId, this.context.publicationId, requireDate(date)],
    );
    return result.rows[0]?.payload ?? null;
  }

  async readCompiled(date: string): Promise<unknown | null> {
    const result = await this.pool.query<JsonRow>(
      `SELECT compiled_payload AS payload
       FROM app.compiled_editions
       WHERE space_id = $1 AND publication_id = $2 AND issue_date = $3::date`,
      [this.context.tenant.spaceId, this.context.publicationId, requireDate(date)],
    );
    return result.rows[0]?.payload ?? null;
  }

  async readIndex(): Promise<{ latest: string; dates: string[] } | null> {
    const client = await this.pool.connect();
    try {
      const dates = await listDates(client, this.context);
      return dates.length === 0 ? null : { latest: dates[0], dates };
    } finally {
      client.release();
    }
  }
}

export function createPostgresDailyStorage(
  pool: PostgresPool,
  context: PublicationContext,
  retention?: { submissionDays: number },
): PostgresDailyStorage {
  return new PostgresDailyStorage(pool, context, retention);
}
