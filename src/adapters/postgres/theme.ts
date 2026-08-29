import type { PoolClient, QueryResultRow } from "pg";
import type { PostgresPool } from "./pool.js";
import type { PublicationContext, TenantContext } from "./tenancy.js";
import { requirePublicationContext, requireTenantContext } from "./tenancy.js";

const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ThemeStorageErrorCode = "THEME_INPUT_INVALID" | "THEME_STORAGE_FAILED";

export class ThemeStorageError extends Error {
  constructor(readonly code: ThemeStorageErrorCode, message: string, options?: ErrorOptions) {
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

export interface ResolvedTheme {
  themeId: string;
  name: string;
  source: "official" | "custom";
  revision: number;
  definition: Record<string, unknown>;
  css: string;
}

export interface EffectiveTheme extends ResolvedTheme {
  selectionMode: "inherit" | "override";
}

interface SelectionRow extends QueryResultRow {
  selection_mode: "inherit" | "override";
  theme_id: string | null;
}

interface CustomThemeRow extends QueryResultRow {
  theme_id: string;
  display_name: string;
  current_revision: number;
  definition_payload: Record<string, unknown>;
  compiled_css: string;
}

interface RevisionRow extends QueryResultRow {
  definition_payload: Record<string, unknown>;
  compiled_css: string;
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

function themeName(definition: Record<string, unknown>, fallback: string): string {
  return typeof definition.name === "string" && definition.name.trim() !== ""
    ? definition.name
    : fallback;
}

export class PostgresThemeStorage {
  private readonly targetType: "home" | "publication";
  private readonly publicationId: string | null;

  constructor(
    private readonly pool: PostgresPool,
    private readonly tenant: TenantContext,
    private readonly systemThemes: SystemThemeReader,
    publication?: PublicationContext,
  ) {
    requireTenantContext(tenant);
    if (publication) {
      requirePublicationContext(publication);
      if (publication.tenant.spaceId !== tenant.spaceId || publication.tenant.userId !== tenant.userId) {
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

  private async assertTenantOwnership(client: PoolClient): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM app.spaces WHERE id = $1 AND user_id = $2 AND status = 'ready'`,
      [this.tenant.spaceId, this.tenant.userId],
    );
    if (result.rowCount !== 1) {
      throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme catalog is unavailable");
    }
  }

  private async readSelectionRow(client: PoolClient): Promise<SelectionRow> {
    const target = this.selectionWhere();
    const result = await client.query<SelectionRow>(
      `SELECT selection_mode, theme_id FROM app.theme_selections WHERE ${target.sql}`,
      target.values,
    );
    if (!result.rows[0]) {
      throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme selection is unavailable");
    }
    return result.rows[0];
  }

  private async readHomeThemeId(client: PoolClient): Promise<string> {
    const result = await client.query<SelectionRow>(
      `SELECT selection_mode, theme_id
       FROM app.theme_selections
       WHERE space_id = $1 AND target_type = 'home' AND publication_id IS NULL`,
      [this.tenant.spaceId],
    );
    const row = result.rows[0];
    if (!row?.theme_id || row.selection_mode !== "override") {
      throw new ThemeStorageError("THEME_STORAGE_FAILED", "Home theme selection is unavailable");
    }
    return row.theme_id;
  }

  private async readCustomCurrent(client: PoolClient, themeId: string): Promise<ResolvedTheme | null> {
    const result = await client.query<CustomThemeRow>(
      `SELECT catalog.theme_id, catalog.display_name, catalog.current_revision,
              definition.definition_payload, definition.compiled_css
       FROM app.custom_themes AS catalog
       JOIN app.theme_definitions AS definition
         ON definition.space_id = catalog.space_id
        AND definition.theme_id = catalog.theme_id
        AND definition.revision = catalog.current_revision
       WHERE catalog.space_id = $1 AND catalog.theme_id = $2 AND catalog.status = 'active'`,
      [this.tenant.spaceId, themeId],
    );
    const row = result.rows[0];
    return row ? {
      themeId: row.theme_id,
      name: row.display_name,
      source: "custom",
      revision: row.current_revision,
      definition: row.definition_payload,
      css: row.compiled_css,
    } : null;
  }

  private async readOfficialCurrent(themeId: string): Promise<ResolvedTheme | null> {
    const revisions = await this.systemThemes.listRevisions(themeId);
    const revision = revisions.length > 0 ? Math.max(...revisions) : null;
    if (!revision) return null;
    const record = await this.systemThemes.readThemeRevision(themeId, revision);
    return record ? {
      themeId,
      name: themeName(record.definition, themeId),
      source: "official",
      revision,
      definition: record.definition,
      css: record.css,
    } : null;
  }

  async listThemes(): Promise<Array<Omit<ResolvedTheme, "definition" | "css">>> {
    const client = await this.pool.connect();
    try {
      await this.assertTenantOwnership(client);
      const custom = await client.query<CustomThemeRow>(
        `SELECT catalog.theme_id, catalog.display_name, catalog.current_revision,
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
      const official = await Promise.all((await this.systemThemes.listThemeIds()).map(async (themeId) => {
        const current = await this.readOfficialCurrent(themeId);
        return current && {
          themeId: current.themeId,
          name: current.name,
          source: current.source,
          revision: current.revision,
        };
      }));
      const officialThemes = official.filter(
        (theme): theme is Omit<ResolvedTheme, "definition" | "css"> => theme !== null,
      );
      const officialIds = new Set(officialThemes.map(({ themeId }) => themeId));
      return [
        ...officialThemes,
        ...custom.rows.filter((row) => !officialIds.has(row.theme_id)).map((row) => ({
          themeId: row.theme_id,
          name: row.display_name,
          source: "custom" as const,
          revision: row.current_revision,
        })),
      ];
    } finally {
      client.release();
    }
  }

  async readCurrentTheme(themeId: string): Promise<ResolvedTheme | null> {
    const id = requireThemeId(themeId);
    const client = await this.pool.connect();
    try {
      await this.assertTenantOwnership(client);
      return await this.readOfficialCurrent(id) ?? await this.readCustomCurrent(client, id);
    } finally {
      client.release();
    }
  }

  async readThemeRevision(
    themeId: string,
    revision: number,
  ): Promise<{ definition: Record<string, unknown>; css: string } | null> {
    const id = requireThemeId(themeId);
    const resolvedRevision = requireRevision(revision);
    const client = await this.pool.connect();
    try {
      await this.assertTenantOwnership(client);
      const official = await this.systemThemes.readThemeRevision(id, resolvedRevision);
      if (official) return official;
      const result = await client.query<RevisionRow>(
        `SELECT definition_payload, compiled_css
         FROM app.theme_definitions
         WHERE space_id = $1 AND theme_id = $2 AND revision = $3`,
        [this.tenant.spaceId, id, resolvedRevision],
      );
      return result.rows[0]
        ? { definition: result.rows[0].definition_payload, css: result.rows[0].compiled_css }
        : null;
    } finally {
      client.release();
    }
  }

  async readSelection(): Promise<
    { schemaVersion: 3; mode: "inherit" }
    | { schemaVersion: 3; mode: "override"; themeId: string }
  > {
    const client = await this.pool.connect();
    try {
      await this.assertTenantOwnership(client);
      const row = await this.readSelectionRow(client);
      if (row.selection_mode === "inherit") return { schemaVersion: 3, mode: "inherit" };
      if (!row.theme_id) {
        throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme selection is incomplete");
      }
      return { schemaVersion: 3, mode: "override", themeId: row.theme_id };
    } finally {
      client.release();
    }
  }

  async resolveEffectiveTheme(): Promise<EffectiveTheme> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assertTenantOwnership(client);
      const selection = await this.readSelectionRow(client);
      const themeId = selection.selection_mode === "inherit"
        ? await this.readHomeThemeId(client)
        : selection.theme_id;
      if (!themeId) {
        throw new ThemeStorageError("THEME_STORAGE_FAILED", "effective theme selection is incomplete");
      }
      const current = await this.readOfficialCurrent(themeId) ?? await this.readCustomCurrent(client, themeId);
      if (!current) {
        throw new ThemeStorageError("THEME_STORAGE_FAILED", "effective theme is unavailable");
      }
      const effective = { ...current, selectionMode: selection.selection_mode };
      await client.query("COMMIT");
      return effective;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresThemeStorage(
  pool: PostgresPool,
  tenant: TenantContext,
  systemThemes: SystemThemeReader,
  publication?: PublicationContext,
): PostgresThemeStorage {
  return new PostgresThemeStorage(pool, tenant, systemThemes, publication);
}
