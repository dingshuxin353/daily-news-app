import type { PostgresPool } from "../../adapters/postgres/pool.js";
import { createPostgresDailyStorage } from "../../adapters/postgres/daily.js";
import { createPostgresTodoStorage } from "../../adapters/postgres/todo.js";
import { createPostgresThemeStorage, type SystemThemeReader } from "../../adapters/postgres/theme.js";
import type {
  HomeProfileRecord,
  PostgresTenancyStore,
  PublicationContext,
  PublicationRecord,
  TenantContext,
  TodoProfileRecord,
} from "../../adapters/postgres/tenancy.js";
import { buildDailyReadingProjection } from "../../../scripts/lib/domain/daily-reading.js";
import { buildTodoProjection } from "../../../scripts/lib/domain/todo-projection.js";
import { colorSchemeForTheme } from "../../../scripts/lib/theme-compiler.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface ReadingTheme {
  id: string;
  revision: number;
  colorScheme: "light" | "dark";
}

export interface ReadingShell {
  spaceName: string;
  timeZone: string;
  publication: PublicationRecord;
  theme: ReadingTheme;
  todoEnabled: boolean;
  todoHasFormalData: boolean;
  nickname?: string | null;
}

interface ProfileReader {
  read(userId: string): Promise<{ nickname: string | null } | null>;
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
  dates: string[];
}

export interface PublicationReadingSummary {
  publication: PublicationRecord;
  latest: null | {
    date: string;
    title: string;
  };
}

export interface HomeReading {
  shell: ReadingShell;
  daily: DailyReading | null;
  publications: PublicationReadingSummary[];
  todoProjection: ReturnType<typeof buildTodoProjection> | null;
}

export interface PublicationDirectoryReading {
  shell: ReadingShell;
  publications: PublicationReadingSummary[];
}

export interface DailyReadingResult {
  daily: DailyReading | null;
  dates: string[];
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
  pool: PostgresPool,
  systemThemes: SystemThemeReader,
  tenant: TenantContext,
  publicationContext: PublicationContext | undefined,
  home: HomeProfileRecord | null,
  publication: PublicationRecord,
  todo: TodoProfileRecord | null,
  todoHasFormalData: boolean,
  nickname: string | null,
): Promise<ReadingShell> {
  const effectiveTheme = await createPostgresThemeStorage(pool, tenant, systemThemes, publicationContext)
    .resolveEffectiveTheme();
  if (!home || !todo) {
    throw new Error("private reading bootstrap is incomplete");
  }
  return {
    spaceName: home.displayName,
    timeZone: home.timeZone,
    publication,
    theme: {
      id: effectiveTheme.themeId,
      revision: effectiveTheme.revision,
      colorScheme: colorSchemeForTheme(effectiveTheme.definition),
    },
    todoEnabled: todo.enabled,
    todoHasFormalData,
    nickname,
  };
}

function dailyReading(snapshot: {
  date: string;
  issue: unknown;
  compiled: unknown;
  dates: string[];
}): DailyReading {
  const projection = buildDailyReadingProjection(snapshot.compiled, snapshot.issue);
  return {
    date: snapshot.date,
    issue: snapshot.issue as Record<string, unknown>,
    compiled: snapshot.compiled as Record<string, unknown>,
    projection,
    dates: snapshot.dates,
  };
}

function readingTitle(reading: DailyReading): string {
  const title = reading.projection.rows[0]?.modules[0]?.item.title;
  return typeof title === "string" && title.trim() !== "" ? title : "打开这期正式日报";
}

export class PrivateReadingService {
  constructor(
    private readonly pool: PostgresPool,
    private readonly tenancy: PostgresTenancyStore,
    private readonly systemThemes: SystemThemeReader,
    private readonly now: () => Date = () => new Date(),
    private readonly profiles?: ProfileReader,
  ) {}

  async readShell(tenant: TenantContext): Promise<ReadingShell> {
    const repository = this.tenancy.forTenant(tenant);
    const todoStorage = createPostgresTodoStorage(this.pool, tenant);
    const [home, publications, todo, todoAvailability, profile] = await Promise.all([
      repository.getHomeProfile(),
      repository.listPublications(),
      repository.getTodoProfile(),
      todoStorage.readAvailability(),
      this.profiles?.read(tenant.userId) ?? Promise.resolve(null),
    ]);
    const publication = publications.find((item) => item.isDefault && item.status === "active");
    if (!publication) {
      throw new Error("private reading bootstrap is incomplete");
    }
    return buildReadingShell(
      this.pool,
      this.systemThemes,
      tenant,
      undefined,
      home,
      publication,
      todo,
      todoAvailability.hasFormalData,
      profile?.nickname ?? null,
    );
  }

  async readPublicationShell(tenant: TenantContext, publicationId: string): Promise<ReadingShell | null> {
    const publicationContext = await this.tenancy.resolvePublicationContext(tenant, publicationId);
    if (!publicationContext) return null;
    const tenantRepository = this.tenancy.forTenant(tenant);
    const publicationRepository = this.tenancy.forPublication(publicationContext);
    const [publication, home, todo, todoAvailability, profile] = await Promise.all([
      publicationRepository.getPublication(),
      tenantRepository.getHomeProfile(),
      tenantRepository.getTodoProfile(),
      createPostgresTodoStorage(this.pool, tenant).readAvailability(),
      this.profiles?.read(tenant.userId) ?? Promise.resolve(null),
    ]);
    if (!publication) return null;
    return buildReadingShell(
      this.pool,
      this.systemThemes,
      tenant,
      publicationContext,
      home,
      publication,
      todo,
      todoAvailability.hasFormalData,
      profile?.nickname ?? null,
    );
  }

  async readDaily(tenant: TenantContext, publicationId: string, requestedDate?: string): Promise<DailyReading | null> {
    if (requestedDate !== undefined && !isDate(requestedDate)) return null;
    const publication = await this.tenancy.resolvePublicationContext(tenant, publicationId);
    if (!publication) return null;
    const repository = this.tenancy.forPublication(publication);
    const record = await repository.getPublication();
    if (!record) return null;
    const storage = createPostgresDailyStorage(this.pool, publication);
    const snapshot = await storage.readSnapshot(requestedDate);
    if (!snapshot) return null;
    return dailyReading(snapshot);
  }

  async readDailyResult(tenant: TenantContext, publicationId: string, requestedDate?: string): Promise<DailyReadingResult | null> {
    if (requestedDate !== undefined && !isDate(requestedDate)) return null;
    const publication = await this.tenancy.resolvePublicationContext(tenant, publicationId);
    if (!publication) return null;
    const record = await this.tenancy.forPublication(publication).getPublication();
    if (!record) return null;
    const storage = createPostgresDailyStorage(this.pool, publication);
    const snapshot = await storage.readSnapshot(requestedDate);
    if (snapshot) return { daily: dailyReading(snapshot), dates: snapshot.dates };
    const index = await storage.readIndex();
    return { daily: null, dates: index?.dates ?? [] };
  }

  private async readPublicationSummaries(
    tenant: TenantContext,
    publications: PublicationRecord[],
  ): Promise<PublicationReadingSummary[]> {
    return Promise.all(publications.map(async (publication) => {
      const context = await this.tenancy.resolvePublicationContext(tenant, publication.publicationId);
      if (!context) throw new Error("private reading publication ownership changed during read");
      const snapshot = await createPostgresDailyStorage(this.pool, context).readSnapshot();
      if (!snapshot) return { publication, latest: null };
      const reading = dailyReading(snapshot);
      return { publication, latest: { date: reading.date, title: readingTitle(reading) } };
    }));
  }

  async readHome(tenant: TenantContext): Promise<HomeReading> {
    const shell = await this.readShell(tenant);
    const publications = (await this.tenancy.forTenant(tenant).listPublications())
      .filter(({ status }) => status === "active");
    const primary = publications.find(({ isDefault }) => isDefault);
    if (!primary) throw new Error("private reading bootstrap is incomplete");
    const [daily, summaries, todo] = await Promise.all([
      this.readDaily(tenant, primary.publicationId),
      this.readPublicationSummaries(tenant, publications.filter(({ isDefault }) => !isDefault)),
      shell.todoEnabled && shell.todoHasFormalData ? this.readTodo(tenant) : Promise.resolve(null),
    ]);
    return {
      shell,
      daily,
      publications: summaries.filter(({ latest }) => latest !== null),
      todoProjection: todo?.enabled ? todo.projection : null,
    };
  }

  async readPublicationDirectory(tenant: TenantContext): Promise<PublicationDirectoryReading> {
    const shell = await this.readShell(tenant);
    const publications = (await this.tenancy.forTenant(tenant).listPublications())
      .filter(({ status }) => status === "active");
    return { shell, publications: await this.readPublicationSummaries(tenant, publications) };
  }

  async readLatestDaily(tenant: TenantContext): Promise<DailyReading | null> {
    const shell = await this.readShell(tenant);
    return this.readDaily(tenant, shell.publication.publicationId);
  }

  async readThemeCss(tenant: TenantContext, themeId: string, revision: number): Promise<string | null> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(themeId) || !Number.isInteger(revision) || revision < 1) return null;
    const theme = await createPostgresThemeStorage(this.pool, tenant, this.systemThemes)
      .readThemeRevision(themeId, revision);
    return theme?.css ?? null;
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
