import type { PoolClient, QueryResultRow } from "pg";
import type { TenantContext } from "./tenancy.js";
import { requireTenantContext } from "./tenancy.js";
import type { PostgresPool } from "./pool.js";

const CANDIDATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMPTY_STATE = Object.freeze({ schemaVersion: 1, revision: 0, updatedAt: null, items: [] });

export type TodoStorageErrorCode =
  | "TODO_INPUT_INVALID"
  | "TODO_DISABLED"
  | "TODO_IDEMPOTENCY_CONFLICT"
  | "TODO_STORAGE_FAILED";

export class TodoStorageError extends Error {
  constructor(
    readonly code: TodoStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TodoStorageError";
  }
}

export interface TodoWriteTransaction {
  readSubmission(): Promise<unknown | null>;
  readState(): Promise<unknown>;
  commit(changes: Record<string, unknown>): Promise<void>;
}

export interface TodoApplicationStorage {
  withWriteTransaction<T>(
    candidateId: string,
    work: (transaction: TodoWriteTransaction) => Promise<T>,
  ): Promise<T>;
}

interface TodoProfileRow extends QueryResultRow {
  enabled: boolean;
}

interface JsonRow extends QueryResultRow {
  payload: unknown;
}

interface SubmissionRow extends QueryResultRow {
  payload_hash: string;
  result_payload: unknown;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TodoStorageError("TODO_INPUT_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireCandidateId(value: unknown): string {
  if (typeof value !== "string" || !CANDIDATE_ID.test(value)) {
    throw new TodoStorageError("TODO_INPUT_INVALID", "candidateId is invalid");
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TodoStorageError("TODO_INPUT_INVALID", "Todo state revision is invalid");
  }
  return value as number;
}

async function readState(client: PoolClient, context: TenantContext): Promise<unknown> {
  const result = await client.query<JsonRow>(
    `SELECT state_payload AS payload
     FROM app.todo_states
     WHERE space_id = $1`,
    [context.spaceId],
  );
  return result.rows[0]?.payload ?? structuredClone(EMPTY_STATE);
}

function createApplicationStorage(
  client: PoolClient,
  context: TenantContext,
  candidateId: string,
  payloadHash: string,
  candidate: Record<string, unknown>,
): TodoApplicationStorage {
  let entered = false;
  let committed = false;
  return Object.freeze({
    async withWriteTransaction<T>(
      requestedCandidateId: string,
      work: (transaction: TodoWriteTransaction) => Promise<T>,
    ): Promise<T> {
      if (entered || requestedCandidateId !== candidateId) {
        throw new TodoStorageError("TODO_STORAGE_FAILED", "Todo transaction context is invalid");
      }
      entered = true;
      const transaction: TodoWriteTransaction = {
        async readSubmission() {
          const result = await client.query<JsonRow>(
            `SELECT result_payload AS payload
             FROM app.todo_submission_runs
             WHERE space_id = $1 AND candidate_id = $2`,
            [context.spaceId, candidateId],
          );
          return result.rows[0]?.payload ?? null;
        },
        readState() {
          return readState(client, context);
        },
        async commit(changes: Record<string, unknown>) {
          if (committed) {
            throw new TodoStorageError("TODO_STORAGE_FAILED", "Todo transaction was already committed");
          }
          const state = changes.state;
          if (state !== undefined) {
            const payload = requireRecord(state, "Todo state");
            const revision = requireRevision(payload.revision);
            await client.query(
              `INSERT INTO app.todo_states (space_id, revision, state_payload)
               VALUES ($1, $2, $3::jsonb)
               ON CONFLICT (space_id) DO UPDATE
                 SET revision = EXCLUDED.revision,
                     state_payload = EXCLUDED.state_payload,
                     updated_at = clock_timestamp()`,
              [context.spaceId, revision, JSON.stringify(payload)],
            );
          }
          const submission = requireRecord(changes.submission, "Todo submission result");
          await client.query(
            `INSERT INTO app.todo_submission_runs
               (space_id, candidate_id, payload_hash, candidate_payload, result_payload)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
            [
              context.spaceId,
              candidateId,
              payloadHash,
              JSON.stringify(candidate),
              JSON.stringify(submission),
            ],
          );
          committed = true;
        },
      };
      return work(transaction);
    },
  });
}

export class PostgresTodoStorage {
  constructor(
    private readonly pool: PostgresPool,
    private readonly context: TenantContext,
  ) {
    requireTenantContext(context);
  }

  async runSubmission<T>(input: {
    candidateId: string;
    payloadHash: string;
    candidate: unknown;
  }, work: (storage: TodoApplicationStorage) => Promise<T>): Promise<T> {
    const candidateId = requireCandidateId(input.candidateId);
    const candidate = requireRecord(input.candidate, "Todo Candidate");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const profile = await client.query<TodoProfileRow>(
        `SELECT enabled
         FROM app.todo_profiles
         WHERE space_id = $1
         FOR UPDATE`,
        [this.context.spaceId],
      );
      if (!profile.rows[0]?.enabled) {
        throw new TodoStorageError("TODO_DISABLED", "Personal Todo is disabled");
      }

      const existing = await client.query<SubmissionRow>(
        `SELECT payload_hash, result_payload
         FROM app.todo_submission_runs
         WHERE space_id = $1 AND candidate_id = $2`,
        [this.context.spaceId, candidateId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== input.payloadHash) {
          throw new TodoStorageError(
            "TODO_IDEMPOTENCY_CONFLICT",
            "candidateId was already used for different input",
          );
        }
        await client.query("COMMIT");
        return existing.rows[0].result_payload as T;
      }

      const result = await work(
        createApplicationStorage(client, this.context, candidateId, input.payloadHash, candidate),
      );
      const persisted = await client.query<JsonRow>(
        `SELECT result_payload AS payload
         FROM app.todo_submission_runs
         WHERE space_id = $1 AND candidate_id = $2`,
        [this.context.spaceId, candidateId],
      );
      if (!persisted.rows[0]) {
        throw new TodoStorageError("TODO_STORAGE_FAILED", "Todo application did not persist a submission result");
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof TodoStorageError) throw error;
      throw new TodoStorageError("TODO_STORAGE_FAILED", "Todo submission failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async readState(): Promise<unknown> {
    const client = await this.pool.connect();
    try {
      return readState(client, this.context);
    } finally {
      client.release();
    }
  }
}

export function createPostgresTodoStorage(
  pool: PostgresPool,
  context: TenantContext,
): PostgresTodoStorage {
  return new PostgresTodoStorage(pool, context);
}
