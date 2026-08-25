import type { PoolClient, QueryResultRow } from "pg";
import type { PostgresPool } from "./pool.js";
import type { PublicationContext, TenantContext } from "./tenancy.js";
import { requirePublicationContext, requireTenantContext } from "./tenancy.js";

const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;

export type ThemeStorageErrorCode = "THEME_INPUT_INVALID" | "THEME_STORAGE_FAILED";

export class ThemeStorageError extends Error {
  constructor(
    readonly code: ThemeStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ThemeStorageError";
  }
}

export interface SystemThemeReader {
  listThemeIds(): Promise<string[]>;
  listRevisions(themeId: string): Promise<number[]>;
  readThemeRevision(themeId: string, revision: number): Promise<{
    definition: Record<string, unknown>;
    css: string;
  } | null>;
}

export type ThemeManifestFactory = (
  definition: Record<string, unknown>,
  cssPath: string,
  candidateHash: string | null,
) => Record<string, unknown>;

interface SelectionRow extends QueryResultRow {
  selection_mode: "inherit" | "override";
  theme_id: string | null;
  theme_revision: number | null;
  active_payload: unknown | null;
}

interface PreviewRow extends QueryResultRow {
  manifest_payload: Record<string, unknown>;
  compiled_css: string;
}

interface RevisionRow extends QueryResultRow {
  definition_payload: Record<string, unknown>;
  compiled_css: string;
}

interface IdRow extends QueryResultRow {
  theme_id: string;
}

interface RevisionNumberRow extends QueryResultRow {
  revision: number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThemeStorageError("THEME_INPUT_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireThemeId(value: unknown): string {
  if (typeof value !== "string" || !THEME_ID.test(value)) {
    throw new ThemeStorageError("THEME_INPUT_INVALID", "themeId is invalid");
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ThemeStorageError("THEME_INPUT_INVALID", "theme revision is invalid");
  }
  return value as number;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new ThemeStorageError("THEME_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

export class PostgresThemeStorage {
  private readonly targetType: "home" | "publication";
  private readonly publicationId: string | null;

  constructor(
    private readonly pool: PostgresPool,
    private readonly tenant: TenantContext,
    private readonly systemThemes: SystemThemeReader,
    private readonly createThemeManifest: ThemeManifestFactory,
    publication?: PublicationContext,
  ) {
    requireTenantContext(tenant);
    if (publication) {
      requirePublicationContext(publication);
      if (
        publication.tenant.spaceId !== tenant.spaceId
        || publication.tenant.userId !== tenant.userId
      ) {
        throw new ThemeStorageError("THEME_INPUT_INVALID", "publication context belongs to another tenant");
      }
      this.targetType = "publication";
      this.publicationId = publication.publicationId;
    } else {
      this.targetType = "home";
      this.publicationId = null;
    }
  }

  private selectionWhere(): { sql: string; values: unknown[] } {
    if (this.targetType === "home") {
      return {
        sql: "space_id = $1 AND target_type = 'home' AND publication_id IS NULL",
        values: [this.tenant.spaceId],
      };
    }
    return {
      sql: "space_id = $1 AND target_type = 'publication' AND publication_id = $2",
      values: [this.tenant.spaceId, this.publicationId],
    };
  }

  private async readSelectionRow(client: PoolClient): Promise<SelectionRow> {
    const target = this.selectionWhere();
    const result = await client.query<SelectionRow>(
      `SELECT selection_mode, theme_id, theme_revision, active_payload
       FROM app.theme_selections
       WHERE ${target.sql}`,
      target.values,
    );
    if (!result.rows[0]) {
      throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme selection is unavailable");
    }
    return result.rows[0];
  }

  private async readHomeReference(client: PoolClient): Promise<{ id: string; revision: number }> {
    const result = await client.query<SelectionRow>(
      `SELECT selection_mode, theme_id, theme_revision, active_payload
       FROM app.theme_selections
       WHERE space_id = $1 AND target_type = 'home' AND publication_id IS NULL`,
      [this.tenant.spaceId],
    );
    const row = result.rows[0];
    if (!row?.theme_id || !row.theme_revision || row.selection_mode !== "override") {
      throw new ThemeStorageError("THEME_STORAGE_FAILED", "Home theme selection is unavailable");
    }
    return { id: row.theme_id, revision: row.theme_revision };
  }

  private async effectiveReference(
    client: PoolClient,
    row?: SelectionRow,
  ): Promise<{ id: string; revision: number }> {
    const selection = row ?? await this.readSelectionRow(client);
    if (selection.selection_mode === "inherit") return this.readHomeReference(client);
    if (!selection.theme_id || !selection.theme_revision) {
      throw new ThemeStorageError("THEME_STORAGE_FAILED", "override theme selection is incomplete");
    }
    return { id: selection.theme_id, revision: selection.theme_revision };
  }

  private async readThemeRevisionWithClient(
    client: PoolClient,
    themeId: string,
    revision: number,
  ): Promise<{ definition: Record<string, unknown>; css: string } | null> {
    const result = await client.query<RevisionRow>(
      `SELECT definition_payload, compiled_css
       FROM app.theme_definitions
       WHERE space_id = $1 AND theme_id = $2 AND revision = $3`,
      [this.tenant.spaceId, requireThemeId(themeId), requireRevision(revision)],
    );
    if (result.rows[0]) {
      return {
        definition: result.rows[0].definition_payload,
        css: result.rows[0].compiled_css,
      };
    }
    return this.systemThemes.readThemeRevision(themeId, revision);
  }

  private async readActiveWithClient(client: PoolClient): Promise<Record<string, unknown> | null> {
    const row = await this.readSelectionRow(client);
    if (row.selection_mode === "override" && row.active_payload) {
      return requireRecord(row.active_payload, "active theme");
    }
    const reference = await this.effectiveReference(client, row);
    const revision = await this.readThemeRevisionWithClient(client, reference.id, reference.revision);
    if (!revision) return null;
    return this.createThemeManifest(
      revision.definition,
      `/themes/compiled/${reference.id}/${reference.revision}.css`,
      null,
    );
  }

  async readPreview(themeId: string): Promise<{ manifest: Record<string, unknown>; css: string } | null> {
    const result = await this.pool.query<PreviewRow>(
      `SELECT manifest_payload, compiled_css
       FROM app.theme_candidates
       WHERE space_id = $1 AND theme_id = $2`,
      [this.tenant.spaceId, requireThemeId(themeId)],
    );
    return result.rows[0]
      ? { manifest: result.rows[0].manifest_payload, css: result.rows[0].compiled_css }
      : null;
  }

  async writePreview(
    themeId: string,
    preview: { manifest: unknown; css: string },
  ): Promise<void> {
    const id = requireThemeId(themeId);
    const manifest = requireRecord(preview.manifest, "theme preview manifest");
    if (manifest.themeId !== id || typeof preview.css !== "string" || preview.css.trim() === "") {
      throw new ThemeStorageError("THEME_INPUT_INVALID", "theme preview is invalid");
    }
    const candidateHash = requireHash(manifest.candidateHash, "candidateHash");
    const inputHash = requireHash(manifest.inputHash, "inputHash");
    await this.pool.query(
      `INSERT INTO app.theme_candidates
         (space_id, theme_id, candidate_hash, input_hash, manifest_payload, compiled_css)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (space_id, theme_id) DO UPDATE
         SET candidate_hash = EXCLUDED.candidate_hash,
             input_hash = EXCLUDED.input_hash,
             manifest_payload = EXCLUDED.manifest_payload,
             compiled_css = EXCLUDED.compiled_css,
             updated_at = clock_timestamp()`,
      [this.tenant.spaceId, id, candidateHash, inputHash, JSON.stringify(manifest), preview.css],
    );
  }

  async listThemeIds(): Promise<string[]> {
    const result = await this.pool.query<IdRow>(
      `SELECT DISTINCT theme_id
       FROM app.theme_definitions
       WHERE space_id = $1
       ORDER BY theme_id`,
      [this.tenant.spaceId],
    );
    return [...new Set([
      ...await this.systemThemes.listThemeIds(),
      ...result.rows.map(({ theme_id }) => theme_id),
    ])].sort();
  }

  async listRevisions(themeId: string): Promise<number[]> {
    const id = requireThemeId(themeId);
    const result = await this.pool.query<RevisionNumberRow>(
      `SELECT revision
       FROM app.theme_definitions
       WHERE space_id = $1 AND theme_id = $2
       ORDER BY revision`,
      [this.tenant.spaceId, id],
    );
    return [...new Set([
      ...await this.systemThemes.listRevisions(id),
      ...result.rows.map(({ revision }) => revision),
    ])].sort((left, right) => left - right);
  }

  async readThemeRevision(
    themeId: string,
    revision: number,
  ): Promise<{ definition: Record<string, unknown>; css: string } | null> {
    const client = await this.pool.connect();
    try {
      return await this.readThemeRevisionWithClient(client, themeId, revision);
    } finally {
      client.release();
    }
  }

  async readSelection(): Promise<Record<string, unknown>> {
    const client = await this.pool.connect();
    try {
      const row = await this.readSelectionRow(client);
      return row.selection_mode === "inherit"
        ? { schemaVersion: 2, mode: "inherit" }
        : {
            schemaVersion: 2,
            mode: "override",
            activeTheme: { id: row.theme_id, revision: row.theme_revision },
          };
    } finally {
      client.release();
    }
  }

  async readHomeActiveTheme(): Promise<{ id: string; revision: number }> {
    const client = await this.pool.connect();
    try {
      return await this.readHomeReference(client);
    } finally {
      client.release();
    }
  }

  async readActive(): Promise<Record<string, unknown> | null> {
    const client = await this.pool.connect();
    try {
      return await this.readActiveWithClient(client);
    } finally {
      client.release();
    }
  }

  async withWriteTransaction<T>(work: (transaction: Record<string, unknown>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM app.spaces WHERE id = $1 FOR UPDATE", [this.tenant.spaceId]);
      let committed = false;
      const transaction = {
        listRevisions: async (themeId: string) => {
          const id = requireThemeId(themeId);
          const result = await client.query<RevisionNumberRow>(
            `SELECT revision
             FROM app.theme_definitions
             WHERE space_id = $1 AND theme_id = $2
             ORDER BY revision`,
            [this.tenant.spaceId, id],
          );
          return [...new Set([
            ...await this.systemThemes.listRevisions(id),
            ...result.rows.map(({ revision }) => revision),
          ])].sort((left, right) => left - right);
        },
        readThemeRevision: (themeId: string, revision: number) => (
          this.readThemeRevisionWithClient(client, themeId, revision)
        ),
        readSelection: async () => {
          const row = await this.readSelectionRow(client);
          return row.selection_mode === "inherit"
            ? { schemaVersion: 2, mode: "inherit" }
            : {
                schemaVersion: 2,
                mode: "override",
                activeTheme: { id: row.theme_id, revision: row.theme_revision },
              };
        },
        readHomeActiveTheme: () => this.readHomeReference(client),
        readActive: () => this.readActiveWithClient(client),
        commit: async (changes: Record<string, unknown>) => {
          if (committed) {
            throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme transaction was already committed");
          }
          const revisionChange = changes.revision;
          if (revisionChange !== undefined) {
            const revisionRecord = requireRecord(revisionChange, "theme revision change");
            const themeId = requireThemeId(revisionRecord.themeId);
            const revision = requireRevision(revisionRecord.revision);
            const definition = requireRecord(revisionRecord.definition, "theme definition");
            if (
              definition.id !== themeId
              || definition.revision !== revision
              || typeof revisionRecord.css !== "string"
              || revisionRecord.css.trim() === ""
            ) {
              throw new ThemeStorageError("THEME_INPUT_INVALID", "theme revision is invalid");
            }
            await client.query(
              `INSERT INTO app.theme_definitions
                 (space_id, theme_id, revision, definition_payload, compiled_css)
               VALUES ($1, $2, $3, $4::jsonb, $5)`,
              [this.tenant.spaceId, themeId, revision, JSON.stringify(definition), revisionRecord.css],
            );
          }

          const selectionChange = changes.selection;
          const activeChange = changes.active;
          if (selectionChange !== undefined || activeChange !== undefined) {
            const selection = selectionChange === undefined
              ? null
              : requireRecord(selectionChange, "theme selection");
            let mode: "inherit" | "override" | null = null;
            let themeId: string | null = null;
            let revision: number | null = null;
            if (selection) {
              if (selection.schemaVersion !== 2 || (selection.mode !== "inherit" && selection.mode !== "override")) {
                throw new ThemeStorageError("THEME_INPUT_INVALID", "theme selection is invalid");
              }
              mode = selection.mode;
              if (mode === "inherit") {
                if (this.targetType !== "publication") {
                  throw new ThemeStorageError("THEME_INPUT_INVALID", "Home theme cannot inherit");
                }
              } else {
                const activeTheme = requireRecord(selection.activeTheme, "activeTheme");
                themeId = requireThemeId(activeTheme.id);
                revision = requireRevision(activeTheme.revision);
              }
            }
            const active = activeChange === undefined ? undefined : requireRecord(activeChange, "active theme");
            const target = this.selectionWhere();
            const values = [...target.values];
            const assignments: string[] = [];
            if (mode) {
              values.push(mode, themeId, revision);
              assignments.push(
                `selection_mode = $${values.length - 2}`,
                `theme_id = $${values.length - 1}`,
                `theme_revision = $${values.length}`,
              );
            }
            if (active !== undefined) {
              values.push(JSON.stringify(active));
              assignments.push(`active_payload = $${values.length}::jsonb`);
            }
            assignments.push("updated_at = clock_timestamp()");
            const result = await client.query(
              `UPDATE app.theme_selections
               SET ${assignments.join(", ")}
               WHERE ${target.sql}`,
              values,
            );
            if (result.rowCount !== 1) {
              throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme selection target is unavailable");
            }
          }
          committed = true;
        },
      };
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof ThemeStorageError) throw error;
      throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme transaction failed", { cause: error });
    } finally {
      client.release();
    }
  }
}

export function createPostgresThemeStorage(
  pool: PostgresPool,
  tenant: TenantContext,
  systemThemes: SystemThemeReader,
  createThemeManifest: ThemeManifestFactory,
  publication?: PublicationContext,
): PostgresThemeStorage {
  return new PostgresThemeStorage(pool, tenant, systemThemes, createThemeManifest, publication);
}
