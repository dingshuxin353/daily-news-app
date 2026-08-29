import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { PostgresPool } from "./pool.js";
import type { SystemThemeReader } from "./theme.js";
import type { TenantContext } from "./tenancy.js";
import { requireTenantContext } from "./tenancy.js";
import {
  SiteManagementError,
  type ManagedPublication,
  type SiteManagementRepository,
  type SiteManagementSnapshot,
} from "../../modules/site-management/service.js";

interface HomeRow extends QueryResultRow {
  name: string;
  theme_id: string;
}

interface PublicationRow extends QueryResultRow {
  publication_id: string;
  name: string;
  status: "active" | "inactive";
  sort_order: number | null;
  selection_mode: "inherit" | "override";
  theme_id: string | null;
}

interface TodoRow extends QueryResultRow {
  enabled: boolean;
  has_formal_data: boolean;
}

interface CountRow extends QueryResultRow {
  count: number;
}

interface StatusRow extends QueryResultRow {
  status: "active" | "inactive";
}

interface IdRow extends QueryResultRow {
  publication_id: string;
}

function mapPublication(row: PublicationRow): ManagedPublication {
  const theme = row.selection_mode === "inherit"
    ? { mode: "inherit" as const }
    : { mode: "override" as const, themeId: row.theme_id as string };
  return {
    publicationId: row.publication_id,
    name: row.name,
    status: row.status,
    sortOrder: row.sort_order,
    isPrimary: row.status === "active" && row.sort_order === 0,
    theme,
  };
}

async function readSnapshot(client: PoolClient, tenant: TenantContext): Promise<SiteManagementSnapshot> {
  const homeResult = await client.query<HomeRow>(
    `SELECT profile.display_name AS name, selection.theme_id
     FROM app.home_profiles AS profile
     JOIN app.theme_selections AS selection
       ON selection.space_id = profile.space_id
      AND selection.target_type = 'home'
      AND selection.publication_id IS NULL
     WHERE profile.space_id = $1`,
    [tenant.spaceId],
  );
  const publicationResult = await client.query<PublicationRow>(
    `SELECT publication.publication_id,
            publication.display_name AS name,
            publication.status,
            publication.sort_order,
            selection.selection_mode,
            selection.theme_id
     FROM app.publications AS publication
     JOIN app.theme_selections AS selection
       ON selection.space_id = publication.space_id
      AND selection.publication_id = publication.publication_id
      AND selection.target_type = 'publication'
     WHERE publication.space_id = $1
     ORDER BY publication.status = 'inactive', publication.sort_order NULLS LAST,
              publication.created_at, publication.publication_id`,
    [tenant.spaceId],
  );
  const todoResult = await client.query<TodoRow>(
    `SELECT profile.enabled,
            EXISTS (
              SELECT 1
              FROM app.todo_states AS state
              WHERE state.space_id = profile.space_id
            ) AS has_formal_data
     FROM app.todo_profiles AS profile
     WHERE profile.space_id = $1`,
    [tenant.spaceId],
  );
  const home = homeResult.rows[0];
  const todo = todoResult.rows[0];
  if (!home?.theme_id || !todo) {
    throw new SiteManagementError("SITE_STORAGE_FAILED", "site management bootstrap is incomplete");
  }
  return {
    home: { name: home.name, themeId: home.theme_id },
    publications: publicationResult.rows.map(mapPublication),
    todo: { enabled: todo.enabled, hasFormalData: todo.has_formal_data },
  };
}

async function activePublicationIds(client: PoolClient, spaceId: string): Promise<string[]> {
  const result = await client.query<IdRow>(
    `SELECT publication_id
     FROM app.publications
     WHERE space_id = $1 AND status = 'active'
     ORDER BY sort_order`,
    [spaceId],
  );
  return result.rows.map(({ publication_id }) => publication_id);
}

async function rewriteActiveOrder(client: PoolClient, spaceId: string, publicationIds: string[]): Promise<void> {
  await client.query(
    `UPDATE app.publications
     SET sort_order = sort_order + 1000
     WHERE space_id = $1 AND status = 'active'`,
    [spaceId],
  );
  for (const [sortOrder, publicationId] of publicationIds.entries()) {
    const result = await client.query(
      `UPDATE app.publications
       SET sort_order = $3, updated_at = clock_timestamp()
       WHERE space_id = $1 AND publication_id = $2 AND status = 'active'`,
      [spaceId, publicationId, sortOrder],
    );
    if (result.rowCount !== 1) {
      throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "publication is unavailable");
    }
  }
}

export class PostgresSiteManagementRepository implements SiteManagementRepository {
  constructor(
    private readonly pool: PostgresPool,
    private readonly systemThemes: SystemThemeReader,
  ) {}

  private async transaction<T>(tenant: TenantContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    requireTenantContext(tenant);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const space = await client.query(
        `SELECT id FROM app.spaces WHERE id = $1 AND user_id = $2 AND status = 'ready' FOR UPDATE`,
        [tenant.spaceId, tenant.userId],
      );
      if (space.rowCount !== 1) {
        throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "site is unavailable");
      }
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof SiteManagementError) throw error;
      const constraint = (error as { constraint?: unknown }).constraint;
      if (constraint === "publications_space_display_name_unique") {
        throw new SiteManagementError("SITE_NAME_CONFLICT", "publication name is already used", { cause: error });
      }
      if (constraint === "publications_pkey") {
        throw new SiteManagementError("SITE_ID_CONFLICT", "publication address is already used", { cause: error });
      }
      throw new SiteManagementError("SITE_STORAGE_FAILED", "site management transaction failed", { cause: error });
    } finally {
      client.release();
    }
  }

  private async assertThemeAvailable(client: PoolClient, tenant: TenantContext, themeId: string): Promise<void> {
    const custom = await client.query(
      `SELECT 1 FROM app.custom_themes
       WHERE space_id = $1 AND theme_id = $2 AND status = 'active'`,
      [tenant.spaceId, themeId],
    );
    if (custom.rowCount === 1) return;
    const revisions = await this.systemThemes.listRevisions(themeId);
    if (revisions.length === 0) {
      throw new SiteManagementError("SITE_THEME_NOT_FOUND", "theme is unavailable");
    }
  }

  async readSnapshot(tenant: TenantContext): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const space = await client.query(
        `SELECT 1 FROM app.spaces WHERE id = $1 AND user_id = $2 AND status = 'ready'`,
        [tenant.spaceId, tenant.userId],
      );
      if (space.rowCount !== 1) {
        throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "site is unavailable");
      }
      const snapshot = await readSnapshot(client, tenant);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof SiteManagementError) throw error;
      throw new SiteManagementError("SITE_STORAGE_FAILED", "site management snapshot failed", { cause: error });
    } finally {
      client.release();
    }
  }

  createPublication(tenant: TenantContext, input: {
    publicationId: string;
    name: string;
    theme: { mode: "inherit" } | { mode: "override"; themeId: string };
    timeZone: string;
    priorityLimits: Record<string, unknown>;
    publicationLimit: number;
  }): Promise<SiteManagementSnapshot> {
    return this.transaction(tenant, async (client) => {
      const count = await client.query<CountRow>(
        `SELECT count(*)::integer AS count FROM app.publications WHERE space_id = $1`,
        [tenant.spaceId],
      );
      if ((count.rows[0]?.count ?? 0) >= input.publicationLimit) {
        throw new SiteManagementError("SITE_LIMIT_REACHED", "publication limit is reached");
      }
      const conflict = await client.query<{ id_conflict: boolean; name_conflict: boolean } & QueryResultRow>(
        `SELECT EXISTS (
                  SELECT 1 FROM app.publications WHERE space_id = $1 AND publication_id = $2
                ) AS id_conflict,
                EXISTS (
                  SELECT 1 FROM app.publications WHERE space_id = $1 AND lower(display_name) = lower($3)
                ) AS name_conflict`,
        [tenant.spaceId, input.publicationId, input.name],
      );
      if (conflict.rows[0]?.id_conflict) {
        throw new SiteManagementError("SITE_ID_CONFLICT", "publication address is already used");
      }
      if (conflict.rows[0]?.name_conflict) {
        throw new SiteManagementError("SITE_NAME_CONFLICT", "publication name is already used");
      }
      if (input.theme.mode === "override") {
        await this.assertThemeAvailable(client, tenant, input.theme.themeId);
      }
      const activeCount = await client.query<CountRow>(
        `SELECT count(*)::integer AS count
         FROM app.publications WHERE space_id = $1 AND status = 'active'`,
        [tenant.spaceId],
      );
      await client.query(
        `INSERT INTO app.publications
           (space_id, publication_id, display_name, status, sort_order)
         VALUES ($1, $2, $3, 'active', $4)`,
        [tenant.spaceId, input.publicationId, input.name, activeCount.rows[0]?.count ?? 0],
      );
      await client.query(
        `INSERT INTO app.publication_configs
           (space_id, publication_id, time_zone, priority_limits)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [tenant.spaceId, input.publicationId, input.timeZone, JSON.stringify(input.priorityLimits)],
      );
      await client.query(
        `INSERT INTO app.theme_selections
           (id, space_id, target_type, publication_id, selection_mode, theme_id)
         VALUES ($1, $2, 'publication', $3, $4, $5)`,
        [
          randomUUID(),
          tenant.spaceId,
          input.publicationId,
          input.theme.mode,
          input.theme.mode === "override" ? input.theme.themeId : null,
        ],
      );
      return readSnapshot(client, tenant);
    });
  }

  renamePublication(tenant: TenantContext, publicationId: string, name: string): Promise<SiteManagementSnapshot> {
    return this.transaction(tenant, async (client) => {
      const result = await client.query(
        `UPDATE app.publications
         SET display_name = $3, updated_at = clock_timestamp()
         WHERE space_id = $1 AND publication_id = $2`,
        [tenant.spaceId, publicationId, name],
      );
      if (result.rowCount !== 1) {
        throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "publication is unavailable");
      }
      return readSnapshot(client, tenant);
    });
  }

  reorderPublications(tenant: TenantContext, publicationIds: string[]): Promise<SiteManagementSnapshot> {
    return this.transaction(tenant, async (client) => {
      const current = await activePublicationIds(client, tenant.spaceId);
      if (
        current.length !== publicationIds.length
        || current.some((publicationId) => !publicationIds.includes(publicationId))
      ) {
        throw new SiteManagementError("SITE_INPUT_INVALID", "publication order must contain every active publication");
      }
      await rewriteActiveOrder(client, tenant.spaceId, publicationIds);
      return readSnapshot(client, tenant);
    });
  }

  setPublicationStatus(
    tenant: TenantContext,
    publicationId: string,
    status: "active" | "inactive",
  ): Promise<SiteManagementSnapshot> {
    return this.transaction(tenant, async (client) => {
      const target = await client.query<StatusRow>(
        `SELECT status FROM app.publications
         WHERE space_id = $1 AND publication_id = $2 FOR UPDATE`,
        [tenant.spaceId, publicationId],
      );
      const currentStatus = target.rows[0]?.status;
      if (!currentStatus) {
        throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "publication is unavailable");
      }
      if (currentStatus === status) return readSnapshot(client, tenant);
      if (status === "inactive") {
        const current = await activePublicationIds(client, tenant.spaceId);
        if (current.length <= 1) {
          throw new SiteManagementError("SITE_LAST_ACTIVE", "the final active publication cannot be disabled");
        }
        await client.query(
          `UPDATE app.publications
           SET status = 'inactive', sort_order = NULL, updated_at = clock_timestamp()
           WHERE space_id = $1 AND publication_id = $2`,
          [tenant.spaceId, publicationId],
        );
        await rewriteActiveOrder(client, tenant.spaceId, current.filter((id) => id !== publicationId));
      } else {
        const current = await activePublicationIds(client, tenant.spaceId);
        await client.query(
          `UPDATE app.publications
           SET status = 'active', sort_order = $3, updated_at = clock_timestamp()
           WHERE space_id = $1 AND publication_id = $2 AND status = 'inactive'`,
          [tenant.spaceId, publicationId, current.length],
        );
      }
      return readSnapshot(client, tenant);
    });
  }

  updateHome(tenant: TenantContext, input: { name?: string; themeId?: string }): Promise<SiteManagementSnapshot> {
    return this.transaction(tenant, async (client) => {
      if (input.themeId) await this.assertThemeAvailable(client, tenant, input.themeId);
      if (input.name !== undefined) {
        const result = await client.query(
          `UPDATE app.home_profiles
           SET display_name = $2, updated_at = clock_timestamp()
           WHERE space_id = $1`,
          [tenant.spaceId, input.name],
        );
        if (result.rowCount !== 1) {
          throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "Home profile is unavailable");
        }
      }
      if (input.themeId !== undefined) {
        const result = await client.query(
          `UPDATE app.theme_selections
           SET theme_id = $2, updated_at = clock_timestamp()
           WHERE space_id = $1 AND target_type = 'home' AND publication_id IS NULL`,
          [tenant.spaceId, input.themeId],
        );
        if (result.rowCount !== 1) {
          throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "Home theme selection is unavailable");
        }
      }
      return readSnapshot(client, tenant);
    });
  }

  setPublicationTheme(
    tenant: TenantContext,
    publicationId: string,
    theme: { mode: "inherit" } | { mode: "override"; themeId: string },
  ): Promise<SiteManagementSnapshot> {
    return this.transaction(tenant, async (client) => {
      if (theme.mode === "override") await this.assertThemeAvailable(client, tenant, theme.themeId);
      const result = await client.query(
        `UPDATE app.theme_selections
         SET selection_mode = $3,
             theme_id = $4,
             updated_at = clock_timestamp()
         WHERE space_id = $1 AND publication_id = $2 AND target_type = 'publication'`,
        [tenant.spaceId, publicationId, theme.mode, theme.mode === "override" ? theme.themeId : null],
      );
      if (result.rowCount !== 1) {
        throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "publication is unavailable");
      }
      return readSnapshot(client, tenant);
    });
  }

  setTodoEnabled(tenant: TenantContext, enabled: boolean): Promise<SiteManagementSnapshot> {
    return this.transaction(tenant, async (client) => {
      const result = await client.query(
        `UPDATE app.todo_profiles
         SET enabled = $2, updated_at = clock_timestamp()
         WHERE space_id = $1`,
        [tenant.spaceId, enabled],
      );
      if (result.rowCount !== 1) {
        throw new SiteManagementError("SITE_TARGET_NOT_FOUND", "Todo profile is unavailable");
      }
      return readSnapshot(client, tenant);
    });
  }
}
