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
  publicationContext: PublicationContext,
  home: HomeProfileRecord | null,
  publication: PublicationRecord,
  todo: TodoProfileRecord | null,
  nickname: string | null,
): Promise<ReadingShell> {
  const effectiveTheme = await createPostgresThemeStorage(
    pool,
    tenant,
    systemThemes,
    publicationContext,
  ).resolveEffectiveTheme();
  if (!home || !todo) {
    throw new Error("private reading bootstrap is incomplete");
  }
  return {
    spaceName: home.displayName,
    timeZone: home.timeZone,
    publication,
    theme: { id: effectiveTheme.themeId, revision: effectiveTheme.revision },
    todoEnabled: todo.enabled,
    nickname,
  };
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
    const [home, publications, todo, profile] = await Promise.all([
      repository.getHomeProfile(),
      repository.listPublications(),
      repository.getTodoProfile(),
      this.profiles?.read(tenant.userId) ?? Promise.resolve(null),
    ]);
    const publication = publications.find((item) => item.isDefault && item.status === "active");
    if (!publication) {
      throw new Error("private reading bootstrap is incomplete");
    }
    const publicationContext = await this.tenancy.resolvePublicationContext(tenant, publication.publicationId);
    if (!publicationContext) throw new Error("private reading bootstrap is incomplete");
    return buildReadingShell(this.pool, this.systemThemes, tenant, publicationContext, home, publication, todo, profile?.nickname ?? null);
  }

  async readPublicationShell(tenant: TenantContext, publicationId: string): Promise<ReadingShell | null> {
    const publicationContext = await this.tenancy.resolvePublicationContext(tenant, publicationId);
    if (!publicationContext) return null;
    const tenantRepository = this.tenancy.forTenant(tenant);
    const publicationRepository = this.tenancy.forPublication(publicationContext);
    const [publication, home, todo, profile] = await Promise.all([
      publicationRepository.getPublication(),
      tenantRepository.getHomeProfile(),
      tenantRepository.getTodoProfile(),
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
      profile?.nickname ?? null,
    );
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
