import type { PostgresPool } from "../../adapters/postgres/pool.js";
import { createPostgresDailyStorage } from "../../adapters/postgres/daily.js";
import { createPostgresTodoStorage } from "../../adapters/postgres/todo.js";
import type { SystemThemeReader } from "../../adapters/postgres/theme.js";
import type {
  HomeProfileRecord,
  PostgresTenancyStore,
  PublicationRecord,
  TenantContext,
  ThemeSelectionRecord,
  TodoProfileRecord,
} from "../../adapters/postgres/tenancy.js";
import { buildDailyReadingProjection } from "../../../scripts/lib/domain/daily-reading.js";
import { buildTodoProjection } from "../../../scripts/lib/domain/todo-projection.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReadingTheme {
  id: string;
  revision: number;
}

export interface ReadingShell {
  spaceName: string;
  timeZone: string;
  publication: PublicationRecord;
  theme: ReadingTheme;
  todoEnabled: boolean;
}

export interface DailyReading {
  date: string;
  issue: Record<string, unknown>;
  compiled: Record<string, unknown>;
  projection: {
    schemaVersion: number;
    date: string;
    rows: Array<{
      usedCapacity: number;
      modules: Array<Record<string, unknown> & { item: Record<string, unknown> }>;
    }>;
  };
}

function effectiveTheme(
  home: ThemeSelectionRecord | undefined,
  publication: ThemeSelectionRecord | undefined,
): ReadingTheme | null {
  if (!home || home.selectionMode !== "override" || !publication) return null;
  const selected = publication.selectionMode === "override" ? publication : home;
  return selected?.themeId && selected.themeRevision
    ? { id: selected.themeId, revision: selected.themeRevision }
    : null;
}

function dateInTimeZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function buildReadingShell(
  systemThemes: SystemThemeReader,
  home: HomeProfileRecord | null,
  publication: PublicationRecord,
  todo: TodoProfileRecord | null,
  themes: ThemeSelectionRecord[],
): Promise<ReadingShell> {
  const theme = effectiveTheme(
    themes.find((item) => item.targetType === "home"),
    themes.find((item) => item.targetType === "publication" && item.publicationId === publication.publicationId),
  );
  const themeRevision = theme
    ? await systemThemes.readThemeRevision(theme.id, theme.revision)
    : null;
  if (!home || !todo || !theme || !themeRevision) {
    throw new Error("private reading bootstrap is incomplete");
  }
  return {
    spaceName: home.displayName,
    timeZone: home.timeZone,
    publication,
    theme,
    todoEnabled: todo.enabled,
  };
}

export class PrivateReadingService {
  constructor(
    private readonly pool: PostgresPool,
    private readonly tenancy: PostgresTenancyStore,
    private readonly systemThemes: SystemThemeReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async readShell(tenant: TenantContext): Promise<ReadingShell> {
    const repository = this.tenancy.forTenant(tenant);
    const [home, publications, todo, themes] = await Promise.all([
      repository.getHomeProfile(),
      repository.listPublications(),
      repository.getTodoProfile(),
      repository.listThemeSelections(),
    ]);
    const publication = publications.find((item) => item.isDefault && item.status === "active");
    if (!publication) {
      throw new Error("private reading bootstrap is incomplete");
    }
    return buildReadingShell(this.systemThemes, home, publication, todo, themes);
  }

  async readPublicationShell(tenant: TenantContext, publicationId: string): Promise<ReadingShell | null> {
    const publicationContext = await this.tenancy.resolvePublicationContext(tenant, publicationId);
    if (!publicationContext) return null;
    const tenantRepository = this.tenancy.forTenant(tenant);
    const publicationRepository = this.tenancy.forPublication(publicationContext);
    const [publication, home, todo, themes] = await Promise.all([
      publicationRepository.getPublication(),
      tenantRepository.getHomeProfile(),
      tenantRepository.getTodoProfile(),
      tenantRepository.listThemeSelections(),
    ]);
    if (!publication) return null;
    return buildReadingShell(this.systemThemes, home, publication, todo, themes);
  }

  async readDaily(tenant: TenantContext, publicationId: string, requestedDate?: string): Promise<DailyReading | null> {
    if (requestedDate !== undefined && !DATE.test(requestedDate)) return null;
    const publication = await this.tenancy.resolvePublicationContext(tenant, publicationId);
    if (!publication) return null;
    const repository = this.tenancy.forPublication(publication);
    const record = await repository.getPublication();
    if (!record) return null;
    const storage = createPostgresDailyStorage(this.pool, publication);
    const snapshot = await storage.readSnapshot(requestedDate);
    if (!snapshot) return null;
    const projection = buildDailyReadingProjection(snapshot.compiled, snapshot.issue);
    return {
      date: snapshot.date,
      issue: snapshot.issue as Record<string, unknown>,
      compiled: snapshot.compiled as Record<string, unknown>,
      projection,
    };
  }

  async readLatestDaily(tenant: TenantContext): Promise<DailyReading | null> {
    const shell = await this.readShell(tenant);
    return this.readDaily(tenant, shell.publication.publicationId);
  }

  async readTodo(tenant: TenantContext) {
    const shell = await this.readShell(tenant);
    const snapshot = await createPostgresTodoStorage(this.pool, tenant).readSnapshot();
    if (!snapshot.enabled || !snapshot.state) return { enabled: false as const, projection: null, counts: null };
    const state = snapshot.state as { items?: Array<{ status?: string }> };
    const currentItems = Array.isArray(state.items) ? state.items.filter(({ status }) => status !== "archived") : [];
    return {
      enabled: true as const,
      projection: buildTodoProjection(snapshot.state, {
        asOfDate: dateInTimeZone(shell.timeZone, this.now()),
      }),
      counts: {
        total: currentItems.length,
        open: currentItems.filter(({ status }) => status === "open").length,
      },
    };
  }

  async setTodoEnabled(tenant: TenantContext, enabled: boolean): Promise<void> {
    const result = await this.pool.query(
      `UPDATE app.todo_profiles
       SET enabled = $2, updated_at = clock_timestamp()
       WHERE space_id = $1`,
      [tenant.spaceId, enabled],
    );
    if (result.rowCount !== 1) throw new Error("Todo profile is unavailable");
  }
}
