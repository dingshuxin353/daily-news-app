import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { CloudFileConfig } from "../../cloud/config.js";
import type { PostgresPool } from "./pool.js";

const tenantContextBrand: unique symbol = Symbol("DailyNewsTenantContext");
const publicationContextBrand: unique symbol = Symbol("DailyNewsPublicationContext");
const PUBLICATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TenantContext {
  readonly userId: string;
  readonly spaceId: string;
  readonly [tenantContextBrand]: true;
}

export interface PublicationContext {
  readonly tenant: TenantContext;
  readonly publicationId: string;
  readonly [publicationContextBrand]: true;
}

export interface SpaceRecord {
  id: string;
  userId: string;
  status: "ready";
}

export interface HomeProfileRecord {
  spaceId: string;
  displayName: string;
  timeZone: string;
}

export interface PublicationRecord {
  spaceId: string;
  publicationId: string;
  displayName: string;
  status: "active" | "inactive";
  isDefault: boolean;
  sortOrder: number;
}

export interface PublicationConfigRecord {
  spaceId: string;
  publicationId: string;
  timeZone: string;
  priorityLimits: CloudFileConfig["defaults"]["priorityLimits"];
}

export interface ThemeSelectionRecord {
  targetType: "home" | "publication";
  publicationId: string | null;
  selectionMode: "inherit" | "override";
  themeId: string | null;
  themeRevision: number | null;
}

export interface TodoProfileRecord {
  spaceId: string;
  enabled: boolean;
}

export type TenancyErrorCode = "TENANCY_INPUT_INVALID" | "SPACE_BOOTSTRAP_FAILED";

export class TenancyError extends Error {
  constructor(
    readonly code: TenancyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TenancyError";
  }
}

interface SpaceRow extends QueryResultRow {
  id: string;
  user_id: string;
  status: "initializing" | "ready";
}

interface HomeProfileRow extends QueryResultRow {
  space_id: string;
  display_name: string;
  time_zone: string;
}

interface PublicationRow extends QueryResultRow {
  space_id: string;
  publication_id: string;
  display_name: string;
  status: "active" | "inactive";
  is_default: boolean;
  sort_order: number;
}

interface PublicationConfigRow extends QueryResultRow {
  space_id: string;
  publication_id: string;
  time_zone: string;
  priority_limits: CloudFileConfig["defaults"]["priorityLimits"];
}

interface ThemeSelectionRow extends QueryResultRow {
  target_type: "home" | "publication";
  publication_id: string | null;
  selection_mode: "inherit" | "override";
  theme_id: string | null;
  theme_revision: number | null;
}

interface TodoProfileRow extends QueryResultRow {
  space_id: string;
  enabled: boolean;
}

interface BootstrapStateRow extends QueryResultRow {
  home_exists: boolean;
  publication_exists: boolean;
  publication_config_exists: boolean;
  home_theme_exists: boolean;
  publication_theme_exists: boolean;
  todo_exists: boolean;
}

function validateUserId(userId: string): string {
  if (typeof userId !== "string" || userId.trim() === "" || userId.length > 512) {
    throw new TenancyError("TENANCY_INPUT_INVALID", "authenticated user id is invalid");
  }
  return userId;
}

function validatePublicationId(publicationId: string): string {
  if (!PUBLICATION_ID.test(publicationId)) {
    throw new TenancyError("TENANCY_INPUT_INVALID", "publication id is invalid");
  }
  return publicationId;
}

function validateDefaults(defaults: CloudFileConfig["defaults"]): void {
  validatePublicationId(defaults.publicationId);
  if (
    defaults.spaceName.trim() === ""
    || defaults.timeZone.trim() === ""
    || defaults.publicationName.trim() === ""
    || defaults.theme.id.trim() === ""
    || !Number.isInteger(defaults.theme.revision)
    || defaults.theme.revision < 1
  ) {
    throw new TenancyError("TENANCY_INPUT_INVALID", "space bootstrap defaults are invalid");
  }
}

function createTenantContext(row: Pick<SpaceRow, "id" | "user_id">): TenantContext {
  return Object.freeze({
    userId: row.user_id,
    spaceId: row.id,
    [tenantContextBrand]: true as const,
  });
}

function createPublicationContext(tenant: TenantContext, publicationId: string): PublicationContext {
  return Object.freeze({
    tenant,
    publicationId,
    [publicationContextBrand]: true as const,
  });
}

function requireTenantContext(context: TenantContext): void {
  if (!context || context[tenantContextBrand] !== true) {
    throw new TenancyError("TENANCY_INPUT_INVALID", "resolved tenant context is required");
  }
}

function requirePublicationContext(context: PublicationContext): void {
  if (!context || context[publicationContextBrand] !== true) {
    throw new TenancyError("TENANCY_INPUT_INVALID", "resolved publication context is required");
  }
  requireTenantContext(context.tenant);
}

function mapSpace(row: SpaceRow): SpaceRecord {
  if (row.status !== "ready") {
    throw new TenancyError("SPACE_BOOTSTRAP_FAILED", "space is unavailable");
  }
  return { id: row.id, userId: row.user_id, status: row.status };
}

function mapHomeProfile(row: HomeProfileRow): HomeProfileRecord {
  return { spaceId: row.space_id, displayName: row.display_name, timeZone: row.time_zone };
}

function mapPublication(row: PublicationRow): PublicationRecord {
  return {
    spaceId: row.space_id,
    publicationId: row.publication_id,
    displayName: row.display_name,
    status: row.status,
    isDefault: row.is_default,
    sortOrder: row.sort_order,
  };
}

function mapPublicationConfig(row: PublicationConfigRow): PublicationConfigRecord {
  return {
    spaceId: row.space_id,
    publicationId: row.publication_id,
    timeZone: row.time_zone,
    priorityLimits: row.priority_limits,
  };
}

function mapThemeSelection(row: ThemeSelectionRow): ThemeSelectionRecord {
  return {
    targetType: row.target_type,
    publicationId: row.publication_id,
    selectionMode: row.selection_mode,
    themeId: row.theme_id,
    themeRevision: row.theme_revision,
  };
}

async function insertBootstrapDefaults(
  client: PoolClient,
  spaceId: string,
  publicationId: string,
  defaults: CloudFileConfig["defaults"],
): Promise<void> {
  await client.query(
    `INSERT INTO app.home_profiles (space_id, display_name, time_zone)
     VALUES ($1, $2, $3)
     ON CONFLICT (space_id) DO NOTHING`,
    [spaceId, defaults.spaceName, defaults.timeZone],
  );
  await client.query(
    `INSERT INTO app.publication_configs (space_id, publication_id, time_zone, priority_limits)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (space_id, publication_id) DO NOTHING`,
    [spaceId, publicationId, defaults.timeZone, JSON.stringify(defaults.priorityLimits)],
  );
  await client.query(
    `INSERT INTO app.theme_selections
       (id, space_id, target_type, publication_id, selection_mode, theme_id, theme_revision)
     VALUES ($1, $2, 'home', NULL, 'override', $3, $4)
     ON CONFLICT (space_id) WHERE target_type = 'home' DO NOTHING`,
    [randomUUID(), spaceId, defaults.theme.id, defaults.theme.revision],
  );
  await client.query(
    `INSERT INTO app.theme_selections
       (id, space_id, target_type, publication_id, selection_mode, theme_id, theme_revision)
     VALUES ($1, $2, 'publication', $3, 'inherit', NULL, NULL)
     ON CONFLICT (space_id, publication_id) WHERE target_type = 'publication' DO NOTHING`,
    [randomUUID(), spaceId, publicationId],
  );
  await client.query(
    `INSERT INTO app.todo_profiles (space_id, enabled)
     VALUES ($1, $2)
     ON CONFLICT (space_id) DO NOTHING`,
    [spaceId, defaults.todoEnabled],
  );
}

async function resolveOrCreateDefaultPublication(
  client: PoolClient,
  spaceId: string,
  defaults: CloudFileConfig["defaults"],
): Promise<string> {
  const existing = await client.query<{ publication_id: string } & QueryResultRow>(
    `SELECT publication_id
     FROM app.publications
     WHERE space_id = $1 AND is_default
     FOR UPDATE`,
    [spaceId],
  );
  if (existing.rows[0]) return existing.rows[0].publication_id;

  await client.query(
    `INSERT INTO app.publications
       (space_id, publication_id, display_name, status, is_default, sort_order)
     VALUES ($1, $2, $3, 'active', true, 0)
     ON CONFLICT (space_id, publication_id) DO UPDATE
       SET is_default = true`,
    [spaceId, defaults.publicationId, defaults.publicationName],
  );
  return defaults.publicationId;
}

async function assertBootstrapComplete(
  client: PoolClient,
  spaceId: string,
  publicationId: string,
): Promise<void> {
  const result = await client.query<BootstrapStateRow>(
    `SELECT
       EXISTS (SELECT 1 FROM app.home_profiles WHERE space_id = $1) AS home_exists,
       EXISTS (
         SELECT 1 FROM app.publications
         WHERE space_id = $1 AND publication_id = $2
       ) AS publication_exists,
       EXISTS (
         SELECT 1 FROM app.publication_configs
         WHERE space_id = $1 AND publication_id = $2
       ) AS publication_config_exists,
       EXISTS (
         SELECT 1 FROM app.theme_selections
         WHERE space_id = $1 AND target_type = 'home'
       ) AS home_theme_exists,
       EXISTS (
         SELECT 1 FROM app.theme_selections
         WHERE space_id = $1 AND publication_id = $2 AND target_type = 'publication'
       ) AS publication_theme_exists,
       EXISTS (SELECT 1 FROM app.todo_profiles WHERE space_id = $1) AS todo_exists`,
    [spaceId, publicationId],
  );
  const state = result.rows[0];
  if (!state || Object.values(state).some((present) => present !== true)) {
    throw new TenancyError("SPACE_BOOTSTRAP_FAILED", "space bootstrap did not produce a complete space");
  }
}

export class PostgresTenancyStore {
  constructor(private readonly pool: PostgresPool) {}

  async ensureSpaceForUser(
    authenticatedUserId: string,
    defaults: CloudFileConfig["defaults"],
  ): Promise<TenantContext> {
    const userId = validateUserId(authenticatedUserId);
    validateDefaults(defaults);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO app.spaces (id, user_id, status)
         VALUES ($1, $2, 'initializing')
         ON CONFLICT (user_id) DO NOTHING`,
        [randomUUID(), userId],
      );
      const spaceResult = await client.query<SpaceRow>(
        `SELECT id, user_id, status
         FROM app.spaces
         WHERE user_id = $1
         FOR UPDATE`,
        [userId],
      );
      const space = spaceResult.rows[0];
      if (!space) {
        throw new TenancyError("SPACE_BOOTSTRAP_FAILED", "space bootstrap could not resolve a space");
      }
      const defaultPublicationId = await resolveOrCreateDefaultPublication(client, space.id, defaults);
      await insertBootstrapDefaults(client, space.id, defaultPublicationId, defaults);
      await assertBootstrapComplete(client, space.id, defaultPublicationId);
      const readyResult = await client.query<SpaceRow>(
        `UPDATE app.spaces
         SET status = 'ready', updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING id, user_id, status`,
        [space.id],
      );
      await client.query("COMMIT");
      return createTenantContext(readyResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof TenancyError) throw error;
      throw new TenancyError("SPACE_BOOTSTRAP_FAILED", "space bootstrap failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async resolveTenantContextForUser(authenticatedUserId: string): Promise<TenantContext | null> {
    const userId = validateUserId(authenticatedUserId);
    const result = await this.pool.query<SpaceRow>(
      `SELECT id, user_id, status
       FROM app.spaces
       WHERE user_id = $1 AND status = 'ready'`,
      [userId],
    );
    return result.rows[0] ? createTenantContext(result.rows[0]) : null;
  }

  async resolvePublicationContext(
    tenant: TenantContext,
    requestedPublicationId: string,
  ): Promise<PublicationContext | null> {
    requireTenantContext(tenant);
    const publicationId = validatePublicationId(requestedPublicationId);
    const result = await this.pool.query(
      `SELECT 1
       FROM app.publications
       WHERE space_id = $1 AND publication_id = $2`,
      [tenant.spaceId, publicationId],
    );
    return result.rowCount === 1 ? createPublicationContext(tenant, publicationId) : null;
  }

  forTenant(context: TenantContext): TenantRepository {
    requireTenantContext(context);
    return new TenantRepository(this.pool, context);
  }

  forPublication(context: PublicationContext): PublicationRepository {
    requirePublicationContext(context);
    return new PublicationRepository(this.pool, context);
  }
}

class TenantRepository {
  constructor(
    private readonly pool: PostgresPool,
    private readonly context: TenantContext,
  ) {
    requireTenantContext(context);
  }

  async getSpace(): Promise<SpaceRecord | null> {
    const result = await this.pool.query<SpaceRow>(
      `SELECT id, user_id, status
       FROM app.spaces
       WHERE id = $1 AND user_id = $2 AND status = 'ready'`,
      [this.context.spaceId, this.context.userId],
    );
    return result.rows[0] ? mapSpace(result.rows[0]) : null;
  }

  async getHomeProfile(): Promise<HomeProfileRecord | null> {
    const result = await this.pool.query<HomeProfileRow>(
      `SELECT space_id, display_name, time_zone
       FROM app.home_profiles
       WHERE space_id = $1`,
      [this.context.spaceId],
    );
    return result.rows[0] ? mapHomeProfile(result.rows[0]) : null;
  }

  async listPublications(): Promise<PublicationRecord[]> {
    const result = await this.pool.query<PublicationRow>(
      `SELECT space_id, publication_id, display_name, status, is_default, sort_order
       FROM app.publications
       WHERE space_id = $1
       ORDER BY publication_id`,
      [this.context.spaceId],
    );
    return result.rows.map(mapPublication);
  }

  async getTodoProfile(): Promise<TodoProfileRecord | null> {
    const result = await this.pool.query<TodoProfileRow>(
      `SELECT space_id, enabled
       FROM app.todo_profiles
       WHERE space_id = $1`,
      [this.context.spaceId],
    );
    const row = result.rows[0];
    return row ? { spaceId: row.space_id, enabled: row.enabled } : null;
  }

  async listThemeSelections(): Promise<ThemeSelectionRecord[]> {
    const result = await this.pool.query<ThemeSelectionRow>(
      `SELECT target_type, publication_id, selection_mode, theme_id, theme_revision
       FROM app.theme_selections
       WHERE space_id = $1
       ORDER BY target_type, publication_id NULLS FIRST`,
      [this.context.spaceId],
    );
    return result.rows.map(mapThemeSelection);
  }
}

class PublicationRepository {
  constructor(
    private readonly pool: PostgresPool,
    private readonly context: PublicationContext,
  ) {
    requirePublicationContext(context);
  }

  async getPublication(): Promise<PublicationRecord | null> {
    const result = await this.pool.query<PublicationRow>(
      `SELECT space_id, publication_id, display_name, status, is_default, sort_order
       FROM app.publications
       WHERE space_id = $1 AND publication_id = $2`,
      [this.context.tenant.spaceId, this.context.publicationId],
    );
    return result.rows[0] ? mapPublication(result.rows[0]) : null;
  }

  async getConfig(): Promise<PublicationConfigRecord | null> {
    const result = await this.pool.query<PublicationConfigRow>(
      `SELECT space_id, publication_id, time_zone, priority_limits
       FROM app.publication_configs
       WHERE space_id = $1 AND publication_id = $2`,
      [this.context.tenant.spaceId, this.context.publicationId],
    );
    return result.rows[0] ? mapPublicationConfig(result.rows[0]) : null;
  }

  async getThemeSelection(): Promise<ThemeSelectionRecord | null> {
    const result = await this.pool.query<ThemeSelectionRow>(
      `SELECT target_type, publication_id, selection_mode, theme_id, theme_revision
       FROM app.theme_selections
       WHERE space_id = $1 AND publication_id = $2 AND target_type = 'publication'`,
      [this.context.tenant.spaceId, this.context.publicationId],
    );
    return result.rows[0] ? mapThemeSelection(result.rows[0]) : null;
  }
}
