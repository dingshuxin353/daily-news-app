import type { PoolClient, QueryResultRow } from "pg";
import type { PostgresPool } from "./pool.js";
import type { TenantContext } from "./tenancy.js";
import { requireTenantContext } from "./tenancy.js";
import { canonicalJson } from "../../modules/shared/canonical-json.js";

const CLIENT_RUN_ID = /^[A-Za-z0-9._-]{8,80}$/;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ThemeManagementErrorCode =
  | "THEME_INPUT_INVALID"
  | "THEME_IDEMPOTENCY_CONFLICT"
  | "THEME_REVISION_CONFLICT"
  | "THEME_TARGET_NOT_FOUND"
  | "THEME_ID_CONFLICT"
  | "THEME_OFFICIAL_READ_ONLY"
  | "THEME_IN_USE"
  | "THEME_LIMIT_REACHED"
  | "THEME_INVALID_TOKEN"
  | "THEME_STORAGE_FAILED";

export class ThemeManagementError extends Error {
  constructor(readonly code: ThemeManagementErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ThemeManagementError";
  }
}

export interface ThemeUsage {
  home: boolean;
  publications: Array<{
    publicationId: string;
    name: string;
    mode: "inherit" | "override";
    status: "active" | "inactive";
  }>;
}

export interface CustomThemeRecord {
  themeId: string;
  name: string;
  revision: number;
  definition: Record<string, unknown>;
  css: string;
}

export interface ThemeMutationResult {
  result: "created" | "updated" | "unchanged" | "deleted";
  themeId: string;
  revision: number;
  affected: ThemeUsage;
}

interface ThemeRow extends QueryResultRow {
  theme_id: string;
  display_name: string;
  current_revision: number;
  status: "active" | "deleted";
  definition_payload: Record<string, unknown>;
  compiled_css: string;
}

interface RunRow extends QueryResultRow {
  payload_hash: string;
  result_payload: ThemeMutationResult;
}

interface CountRow extends QueryResultRow { count: number }

interface UsageRow extends QueryResultRow {
  target_type: "home" | "publication";
  publication_id: string | null;
  selection_mode: "inherit" | "override";
  theme_id: string | null;
  display_name: string | null;
  status: "active" | "inactive" | null;
}

function requireThemeId(value: unknown): string {
  if (typeof value !== "string" || !THEME_ID.test(value)) {
    throw new ThemeManagementError("THEME_INPUT_INVALID", "themeId is invalid");
  }
  return value;
}

function requireClientRunId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_RUN_ID.test(value)) {
    throw new ThemeManagementError("THEME_INPUT_INVALID", "clientRunId is invalid");
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ThemeManagementError("THEME_INPUT_INVALID", "baseRevision is invalid");
  }
  return value as number;
}

function mapTheme(row: ThemeRow): CustomThemeRecord {
  return {
    themeId: row.theme_id,
    name: row.display_name,
    revision: row.current_revision,
    definition: row.definition_payload,
    css: row.compiled_css,
  };
}

async function readUsage(client: PoolClient, spaceId: string, themeId: string): Promise<ThemeUsage> {
  const result = await client.query<UsageRow>(
    `SELECT selection.target_type, selection.publication_id, selection.selection_mode,
            selection.theme_id, publication.display_name, publication.status
     FROM app.theme_selections AS selection
     LEFT JOIN app.publications AS publication
       ON publication.space_id = selection.space_id
      AND publication.publication_id = selection.publication_id
     WHERE selection.space_id = $1
     ORDER BY selection.target_type, publication.sort_order NULLS LAST, selection.publication_id`,
    [spaceId],
  );
  const homeThemeId = result.rows.find((row) => row.target_type === "home")?.theme_id ?? null;
  const home = homeThemeId === themeId;
  const publications = result.rows
    .filter((row) => row.target_type === "publication" && (
      (row.selection_mode === "override" && row.theme_id === themeId)
      || (row.selection_mode === "inherit" && home)
    ))
    .map((row) => ({
      publicationId: row.publication_id as string,
      name: row.display_name as string,
      mode: row.selection_mode,
      status: row.status as "active" | "inactive",
    }));
  return { home, publications };
}

async function readCustom(
  client: PoolClient,
  spaceId: string,
  themeId: string,
  lock = false,
): Promise<ThemeRow | null> {
  const result = await client.query<ThemeRow>(
    `SELECT catalog.theme_id, catalog.display_name, catalog.current_revision, catalog.status,
            definition.definition_payload, definition.compiled_css
     FROM app.custom_themes AS catalog
     JOIN app.theme_definitions AS definition
       ON definition.space_id = catalog.space_id
      AND definition.theme_id = catalog.theme_id
      AND definition.revision = catalog.current_revision
     WHERE catalog.space_id = $1 AND catalog.theme_id = $2
     ${lock ? "FOR UPDATE OF catalog" : ""}`,
    [spaceId, themeId],
  );
  return result.rows[0] ?? null;
}

export class PostgresThemeManagementRepository {
  constructor(private readonly pool: PostgresPool, private readonly tenant: TenantContext) {
    requireTenantContext(tenant);
  }

  private async assertOwnership(client: PoolClient): Promise<void> {
    const result = await client.query(
      "SELECT 1 FROM app.spaces WHERE id = $1 AND user_id = $2 AND status = 'ready'",
      [this.tenant.spaceId, this.tenant.userId],
    );
    if (result.rowCount !== 1) {
      throw new ThemeManagementError("THEME_STORAGE_FAILED", "theme catalog is unavailable");
    }
  }

  async listCustomThemes(): Promise<Array<CustomThemeRecord & { usage: ThemeUsage }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assertOwnership(client);
      const result = await client.query<ThemeRow>(
        `SELECT catalog.theme_id, catalog.display_name, catalog.current_revision, catalog.status,
                definition.definition_payload, definition.compiled_css
         FROM app.custom_themes AS catalog
         JOIN app.theme_definitions AS definition
           ON definition.space_id = catalog.space_id
          AND definition.theme_id = catalog.theme_id
          AND definition.revision = catalog.current_revision
         WHERE catalog.space_id = $1 AND catalog.status = 'active'
         ORDER BY catalog.created_at, catalog.theme_id`,
        [this.tenant.spaceId],
      );
      const themes = await Promise.all(result.rows.map(async (row) => ({
        ...mapTheme(row),
        usage: await readUsage(client, this.tenant.spaceId, row.theme_id),
      })));
      await client.query("COMMIT");
      return themes;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async readCustomTheme(themeId: string): Promise<(CustomThemeRecord & { usage: ThemeUsage }) | null> {
    const id = requireThemeId(themeId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assertOwnership(client);
      const row = await readCustom(client, this.tenant.spaceId, id);
      const value = row?.status === "active" ? { ...mapTheme(row), usage: await readUsage(client, this.tenant.spaceId, id) } : null;
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async readUsage(themeId: string): Promise<ThemeUsage> {
    const id = requireThemeId(themeId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assertOwnership(client);
      const usage = await readUsage(client, this.tenant.spaceId, id);
      await client.query("COMMIT");
      return usage;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async mutate(input: {
    operation: "create" | "update" | "delete";
    themeId: string;
    clientRunId: string;
    payloadHash: string;
    activeCredentialId: string;
    baseRevision?: number;
    definition?: Record<string, unknown>;
    css?: string;
    displayName?: string;
    customThemeLimit: number;
    officialThemeIds: string[];
  }): Promise<ThemeMutationResult> {
    const themeId = requireThemeId(input.themeId);
    const clientRunId = requireClientRunId(input.clientRunId);
    const baseRevision = input.baseRevision === undefined ? undefined : requireRevision(input.baseRevision);
    if (!/^[0-9a-f]{64}$/.test(input.payloadHash) || !THEME_ID.test(themeId)) {
      throw new ThemeManagementError("THEME_INPUT_INVALID", "theme mutation input is invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const space = await client.query(
        `SELECT id FROM app.spaces
         WHERE id = $1 AND user_id = $2 AND status = 'ready' FOR UPDATE`,
        [this.tenant.spaceId, this.tenant.userId],
      );
      if (space.rowCount !== 1) {
        throw new ThemeManagementError("THEME_STORAGE_FAILED", "theme catalog is unavailable");
      }
      const credential = await client.query(
        `SELECT id FROM app.agent_credentials
         WHERE id = $1 AND space_id = $2 AND status = 'active' FOR KEY SHARE`,
        [input.activeCredentialId, this.tenant.spaceId],
      );
      if (credential.rowCount !== 1) {
        throw new ThemeManagementError("THEME_INVALID_TOKEN", "Agent credential is no longer active");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${this.tenant.spaceId}:theme:${clientRunId}`,
      ]);
      const existingRun = await client.query<RunRow>(
        `SELECT payload_hash, result_payload FROM app.theme_operation_runs
         WHERE space_id = $1 AND client_run_id = $2`,
        [this.tenant.spaceId, clientRunId],
      );
      if (existingRun.rows[0]) {
        if (existingRun.rows[0].payload_hash !== input.payloadHash) {
          throw new ThemeManagementError(
            "THEME_IDEMPOTENCY_CONFLICT",
            "clientRunId was already used for different input",
          );
        }
        await client.query("COMMIT");
        return existingRun.rows[0].result_payload;
      }
      if (input.officialThemeIds.includes(themeId)) {
        throw new ThemeManagementError("THEME_OFFICIAL_READ_ONLY", "official Theme is read-only");
      }

      const current = await readCustom(client, this.tenant.spaceId, themeId, true);
      let result: ThemeMutationResult;
      if (input.operation === "create") {
        if (current) throw new ThemeManagementError("THEME_ID_CONFLICT", "themeId is already reserved");
        const count = await client.query<CountRow>(
          `SELECT count(*)::integer AS count FROM app.custom_themes
           WHERE space_id = $1 AND status = 'active'`,
          [this.tenant.spaceId],
        );
        if ((count.rows[0]?.count ?? 0) >= input.customThemeLimit) {
          throw new ThemeManagementError("THEME_LIMIT_REACHED", "custom Theme limit reached");
        }
        if (!input.definition || input.css === undefined || !input.displayName) {
          throw new ThemeManagementError("THEME_INPUT_INVALID", "compiled Theme is required");
        }
        await client.query(
          `INSERT INTO app.theme_definitions
             (space_id, theme_id, revision, definition_payload, compiled_css)
           VALUES ($1, $2, 1, $3::jsonb, $4)`,
          [this.tenant.spaceId, themeId, JSON.stringify(input.definition), input.css],
        );
        await client.query(
          `INSERT INTO app.custom_themes
             (space_id, theme_id, display_name, current_revision)
           VALUES ($1, $2, $3, 1)`,
          [this.tenant.spaceId, themeId, input.displayName],
        );
        result = { result: "created", themeId, revision: 1, affected: { home: false, publications: [] } };
      } else {
        if (!current || current.status !== "active") {
          throw new ThemeManagementError("THEME_TARGET_NOT_FOUND", "custom Theme is unavailable");
        }
        if (current.current_revision !== baseRevision) {
          throw new ThemeManagementError("THEME_REVISION_CONFLICT", "custom Theme revision changed");
        }
        const usage = await readUsage(client, this.tenant.spaceId, themeId);
        if (input.operation === "delete") {
          if (usage.home || usage.publications.length > 0) {
            throw new ThemeManagementError("THEME_IN_USE", "custom Theme is still selected");
          }
          await client.query(
            `UPDATE app.custom_themes
             SET status = 'deleted', deleted_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE space_id = $1 AND theme_id = $2`,
            [this.tenant.spaceId, themeId],
          );
          result = { result: "deleted", themeId, revision: current.current_revision, affected: usage };
        } else {
          if (!input.definition || input.css === undefined || !input.displayName) {
            throw new ThemeManagementError("THEME_INPUT_INVALID", "compiled Theme is required");
          }
          const comparableCurrent = { ...current.definition_payload };
          const comparableNext = { ...input.definition };
          delete comparableCurrent.revision;
          delete comparableNext.revision;
          if (canonicalJson(comparableCurrent) === canonicalJson(comparableNext)) {
            result = { result: "unchanged", themeId, revision: current.current_revision, affected: usage };
          } else {
            const revision = current.current_revision + 1;
            const definition = { ...input.definition, revision };
            await client.query(
              `INSERT INTO app.theme_definitions
                 (space_id, theme_id, revision, definition_payload, compiled_css)
               VALUES ($1, $2, $3, $4::jsonb, $5)`,
              [this.tenant.spaceId, themeId, revision, JSON.stringify(definition), input.css],
            );
            await client.query(
              `UPDATE app.custom_themes
               SET display_name = $3, current_revision = $4, updated_at = clock_timestamp()
               WHERE space_id = $1 AND theme_id = $2`,
              [this.tenant.spaceId, themeId, input.displayName, revision],
            );
            result = { result: "updated", themeId, revision, affected: usage };
          }
        }
      }
      await client.query(
        `INSERT INTO app.theme_operation_runs
           (space_id, client_run_id, operation, theme_id, payload_hash, result_payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [this.tenant.spaceId, clientRunId, input.operation, themeId, input.payloadHash, JSON.stringify(result)],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresThemeManagementRepository(
  pool: PostgresPool,
  tenant: TenantContext,
): PostgresThemeManagementRepository {
  return new PostgresThemeManagementRepository(pool, tenant);
}
