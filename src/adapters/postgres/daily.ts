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
  ) {
    requirePublicationContext(context);
  }

  async runSubmission<T>(input: {
    clientRunId: string;
    date: string;
    mode?: "update" | "replace";
    payloadHash: string;
    candidate: unknown;
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
): PostgresDailyStorage {
  return new PostgresDailyStorage(pool, context);
}
