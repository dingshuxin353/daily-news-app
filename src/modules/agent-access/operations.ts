import { randomBytes } from "node:crypto";
import type { PostgresPool } from "../../adapters/postgres/pool.js";
import {
  createPostgresDailyStorage,
  DailyStorageError,
  type DailyWritePolicy,
} from "../../adapters/postgres/daily.js";
import {
  createPostgresTodoStorage,
  TodoStorageError,
} from "../../adapters/postgres/todo.js";
import {
  createPostgresThemeManagementRepository,
  ThemeManagementError,
} from "../../adapters/postgres/theme-management.js";
import type { SystemThemeReader } from "../../adapters/postgres/theme.js";
import type {
  PostgresTenancyStore,
  PublicationConfigRecord,
  PublicationContext,
  PublicationRecord,
} from "../../adapters/postgres/tenancy.js";
import { createCloudDailyCoordinator } from "../daily/cloud-coordinator.js";
import { createCloudTodoCoordinator } from "../todo/cloud-coordinator.js";
import type {
  AgentRequestContext,
  AgentRequestPolicyRepository,
} from "./request-policy.js";
import { AgentRequestError } from "./request-policy.js";
import { createDailyApplicationService } from "../../../scripts/lib/application/daily-service.js";
import { createTodoApplicationService } from "../../../scripts/lib/application/todo-service.js";
import { validateCandidateValue } from "../../../scripts/lib/domain/content-validation.js";
import { validateTodoCandidate, validateTodoState } from "../../../scripts/lib/domain/todo-validation.js";
import { resolveThemeCandidateValue } from "../../../scripts/lib/domain/theme-validation.js";
import { compileThemeCss, createThemeDefinition } from "../../../scripts/lib/theme-compiler.js";
import { jsonSha256 } from "../shared/canonical-json.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PUBLICATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface DailyConfirmationInput {
  historicalDate: string | null;
  replace: {
    publicationId: string;
    date: string;
    expectedRevision: number;
  } | null;
}

export interface AgentOperationsConfiguration {
  origin: string;
  basePath: string;
  dailyItemLimit: number;
  todoOperationLimit: number;
  concurrentWriteLimitPerSpace: number;
  writeLeaseTtlSeconds: number;
  submissionRetentionDays: number;
  customThemeLimit: number;
}

export interface AgentThemeInput {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  extends: string;
  tokens: Record<string, unknown>;
  recipes: Record<string, unknown>;
}

function requireDate(value: unknown): string {
  if (typeof value !== "string" || !DATE.test(value)) {
    throw new AgentRequestError(400, "invalid_request", "日期必须使用 YYYY-MM-DD 格式。");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AgentRequestError(400, "invalid_request", "日期不是有效的日历日期。");
  }
  return value;
}

function todayInTimeZone(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    throw new AgentRequestError(503, "service_unavailable", "日报时区暂时不可用。");
  }
}

function revisionOf(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const revision = (value as Record<string, unknown>).revision;
  return Number.isInteger(revision) && (revision as number) >= 0 ? revision as number : 0;
}

function mapOperationError(error: unknown): AgentRequestError {
  if (error instanceof AgentRequestError) return error;
  if (error instanceof DailyStorageError) {
    if (error.code === "DAILY_IDEMPOTENCY_CONFLICT") {
      return new AgentRequestError(409, "idempotency_conflict", "同一个幂等键已经用于不同请求。");
    }
    if (error.code === "DAILY_FUTURE_DATE_NOT_ALLOWED") {
      return new AgentRequestError(400, "future_date_not_allowed", "不能写入未来日期的日报。");
    }
    if (error.code === "DAILY_EXPLICIT_CONFIRMATION_REQUIRED") {
      return new AgentRequestError(409, "explicit_confirmation_required", "这次写入需要用户对目标和影响进行明确确认。");
    }
    if (error.code === "DAILY_REVISION_CONFLICT") {
      return new AgentRequestError(409, "revision_conflict", "日报已被更新，请重新读取后再次确认。");
    }
    if (error.code === "DAILY_PUBLICATION_INACTIVE") {
      return new AgentRequestError(409, "publication_inactive", "目标日报已停用，不能接受新的写入。");
    }
    if (error.code === "DAILY_INVALID_TOKEN") {
      return new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
    }
    if (error.code === "DAILY_INPUT_INVALID") {
      return new AgentRequestError(400, "schema_invalid", "Content Candidate 或写入参数不符合契约。");
    }
  }
  if (error instanceof TodoStorageError) {
    if (error.code === "TODO_INVALID_TOKEN") {
      return new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
    }
    if (error.code === "TODO_DISABLED") {
      return new AgentRequestError(409, "todo_disabled", "Personal Todo 尚未启用。");
    }
    if (error.code === "TODO_IDEMPOTENCY_CONFLICT") {
      return new AgentRequestError(409, "idempotency_conflict", "同一个幂等键已经用于不同请求。");
    }
    if (error.code === "TODO_INPUT_INVALID") {
      return new AgentRequestError(400, "schema_invalid", "Todo Candidate 或写入参数不符合契约。");
    }
  }
  if (error instanceof ThemeManagementError) {
    if (error.code === "THEME_IDEMPOTENCY_CONFLICT") {
      return new AgentRequestError(409, "idempotency_conflict", "同一个幂等键已经用于不同请求。");
    }
    if (error.code === "THEME_REVISION_CONFLICT") {
      return new AgentRequestError(409, "revision_conflict", "主题已被更新，请重新读取后再次提交。");
    }
    if (error.code === "THEME_TARGET_NOT_FOUND") {
      return new AgentRequestError(404, "target_not_found", "没有找到目标自定义主题。");
    }
    if (error.code === "THEME_ID_CONFLICT") {
      return new AgentRequestError(409, "theme_conflict", "这个主题地址已经被使用，不能重复创建。");
    }
    if (error.code === "THEME_OFFICIAL_READ_ONLY") {
      return new AgentRequestError(409, "theme_read_only", "官方主题只能读取，不能修改或删除。");
    }
    if (error.code === "THEME_IN_USE") {
      return new AgentRequestError(409, "theme_in_use", "这个主题仍被 Home 或日报使用，不能删除。");
    }
    if (error.code === "THEME_LIMIT_REACHED") {
      return new AgentRequestError(409, "theme_limit_reached", "自定义主题数量已达到上限。");
    }
    if (error.code === "THEME_INVALID_TOKEN") {
      return new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
    }
    if (error.code === "THEME_INPUT_INVALID") {
      return new AgentRequestError(400, "schema_invalid", "主题定义或写入参数不符合契约。");
    }
  }
  const named = error as { name?: unknown; field?: unknown; message?: unknown };
  if (
    typeof named?.name === "string"
    && /(?:Validation|DailyDomain|TodoDomain|TodoError|Candidate)/.test(named.name)
  ) {
    return new AgentRequestError(400, "schema_invalid", "Candidate 不符合当前 Schema 或业务约束。");
  }
  if (error instanceof TypeError) {
    return new AgentRequestError(400, "schema_invalid", "Candidate 不符合当前 Schema。");
  }
  return new AgentRequestError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
}

export class AgentOperationsService {
  constructor(
    private readonly pool: PostgresPool,
    private readonly tenancy: PostgresTenancyStore,
    private readonly policy: AgentRequestPolicyRepository,
    private readonly config: AgentOperationsConfiguration,
    private readonly systemThemes: SystemThemeReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async readOfficialTheme(themeId: string) {
    const revisions = await this.systemThemes.listRevisions(themeId);
    const revision = revisions.length > 0 ? Math.max(...revisions) : null;
    if (!revision) return null;
    const stored = await this.systemThemes.readThemeRevision(themeId, revision);
    if (!stored) return null;
    const definition = stored.definition;
    return {
      themeId,
      name: typeof definition.name === "string" ? definition.name : themeId,
      source: "official" as const,
      revision,
      definition,
    };
  }

  private async requireAgentTheme(input: unknown, expectedThemeId?: string) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AgentRequestError(400, "schema_invalid", "主题定义必须是对象。");
    }
    const candidate = input as AgentThemeInput;
    if (expectedThemeId !== undefined && candidate.id !== expectedThemeId) {
      throw new AgentRequestError(400, "schema_invalid", "主题定义 ID 必须与目标地址一致。");
    }
    if (
      typeof candidate.name !== "string"
      || candidate.name !== candidate.name.trim()
      || candidate.name.length < 1
      || [...candidate.name].length > 40
      || /[\u0000-\u001f\u007f-\u009f]/u.test(candidate.name)
    ) {
      throw new AgentRequestError(400, "schema_invalid", "主题名称必须是 1–40 个可见字符。");
    }
    const official = await this.readOfficialTheme(candidate.extends);
    if (!official) {
      throw new AgentRequestError(400, "schema_invalid", "extends 必须引用当前官方主题。");
    }
    const resolved = await resolveThemeCandidateValue(candidate, {
      source: "Agent Theme",
      loadPreset: async (themeId: string) => {
        const preset = await this.readOfficialTheme(themeId);
        if (!preset) throw new TypeError("official Theme preset is unavailable");
        return preset.definition;
      },
    });
    return resolved;
  }

  private themeSchema() {
    return {
      schemaVersion: 1,
      idPattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      name: { minimumVisibleCharacters: 1, maximumVisibleCharacters: 40 },
      colors: { format: "#RRGGBB", minimumTextContrast: 4.5 },
      enums: {
        fontPreset: ["serif-cn", "sans-cn", "mono"],
        headlineScale: ["restrained", "editorial", "poster"],
        density: ["compact", "balanced", "spacious"],
        ruleStyle: ["hairline", "strong", "double"],
        surfaceStyle: ["flat", "paper", "soft-gradient"],
        motion: ["none", "subtle"],
        masthead: ["compact", "classic", "banner"],
        lead: ["split", "stacked", "editorial"],
        important: ["ruled", "minimal", "contrast"],
        normal: ["compact", "minimal", "accent"],
      },
      forbidden: ["html", "css", "javascript", "remote-font", "url", "layout"],
    };
  }

  async getThemeContext(context: AgentRequestContext) {
    try {
      const repository = createPostgresThemeManagementRepository(this.pool, context.tenant);
      const custom = await repository.listCustomThemes();
      const officialIds = await this.systemThemes.listThemeIds();
      const officialIdSet = new Set(officialIds);
      const official = (await Promise.all(officialIds.map(async (themeId) => {
        const theme = await this.readOfficialTheme(themeId);
        return theme ? { ...theme, usage: await repository.readUsage(themeId) } : null;
      }))).filter((theme): theme is NonNullable<typeof theme> => theme !== null);
      return {
        themeSchema: this.themeSchema(),
        constraints: {
          customThemeLimit: this.config.customThemeLimit,
          customThemeCount: custom.length,
          officialThemesReadOnly: true,
          selectionManagedInBrowser: true,
          baseRevisionRequiredForUpdateAndDelete: true,
        },
        themes: [
          ...official.map(({ definition: _definition, ...theme }) => theme),
          ...custom.filter(({ themeId }) => !officialIdSet.has(themeId)).map(
            ({ css: _css, definition: _definition, ...theme }) => ({ ...theme, source: "custom" as const }),
          ),
        ],
      };
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  async getTheme(context: AgentRequestContext, themeId: string) {
    try {
      if (!PUBLICATION_ID.test(themeId)) {
        throw new AgentRequestError(404, "target_not_found", "没有找到目标主题。");
      }
      const repository = createPostgresThemeManagementRepository(this.pool, context.tenant);
      const official = await this.readOfficialTheme(themeId);
      if (official) return { ...official, usage: await repository.readUsage(themeId) };
      const custom = await repository.readCustomTheme(themeId);
      if (!custom) throw new AgentRequestError(404, "target_not_found", "没有找到目标主题。");
      const { css: _css, ...visible } = custom;
      return { ...visible, source: "custom" as const };
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  private async mutateTheme(context: AgentRequestContext, input: {
    operation: "create" | "update" | "delete";
    themeId: string;
    clientRunId: string;
    baseRevision?: number;
    theme?: unknown;
  }) {
    try {
      const prepared = input.operation === "delete"
        ? null
        : await this.requireAgentTheme(input.theme, input.themeId);
      const revision = input.operation === "create" ? 1 : (input.baseRevision ?? 0) + 1;
      const definition = prepared
        ? createThemeDefinition(prepared.resolved, revision, { usesSiteAccent: prepared.usesSiteAccent })
        : undefined;
      const css = prepared
        ? compileThemeCss(prepared.resolved, revision, { usesSiteAccent: prepared.usesSiteAccent })
        : undefined;
      const payload = {
        operation: input.operation,
        themeId: input.themeId,
        ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
        ...(input.theme === undefined ? {} : { theme: input.theme }),
      };
      const repository = createPostgresThemeManagementRepository(this.pool, context.tenant);
      const officialThemeIds = await this.systemThemes.listThemeIds();
      return await this.policy.withWriteLease({
        tenant: context.tenant,
        credentialId: context.credentialId,
        requestId: context.requestId,
        concurrentLimit: this.config.concurrentWriteLimitPerSpace,
        ttlSeconds: this.config.writeLeaseTtlSeconds,
      }, () => repository.mutate({
        operation: input.operation,
        themeId: input.themeId,
        clientRunId: input.clientRunId,
        payloadHash: jsonSha256(payload),
        activeCredentialId: context.credentialId,
        baseRevision: input.baseRevision,
        definition,
        css,
        displayName: prepared?.candidate.name,
        customThemeLimit: this.config.customThemeLimit,
        officialThemeIds,
      }));
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  createTheme(context: AgentRequestContext, input: { clientRunId: string; theme: unknown }) {
    const themeId = (input.theme as { id?: unknown })?.id;
    if (typeof themeId !== "string") {
      throw new AgentRequestError(400, "schema_invalid", "主题定义缺少合法 ID。");
    }
    return this.mutateTheme(context, { operation: "create", themeId, ...input });
  }

  updateTheme(context: AgentRequestContext, input: {
    themeId: string;
    clientRunId: string;
    baseRevision: number;
    theme: unknown;
  }) {
    return this.mutateTheme(context, { operation: "update", ...input });
  }

  deleteTheme(context: AgentRequestContext, input: {
    themeId: string;
    clientRunId: string;
    baseRevision: number;
  }) {
    return this.mutateTheme(context, { operation: "delete", ...input });
  }

  private absolutePath(pathname: string): string {
    return new URL(`${this.config.basePath}${pathname}`, this.config.origin).href;
  }

  private async resolvePublication(
    context: AgentRequestContext,
    publicationId: string,
  ): Promise<{
    publication: PublicationContext;
    record: PublicationRecord;
    configuration: PublicationConfigRecord;
    timeZone: string;
  }> {
    if (!PUBLICATION_ID.test(publicationId)) {
      throw new AgentRequestError(404, "target_not_found", "没有找到目标日报。");
    }
    const publication = await this.tenancy.resolvePublicationContext(context.tenant, publicationId);
    if (!publication) {
      throw new AgentRequestError(404, "target_not_found", "没有找到目标日报。");
    }
    const repository = this.tenancy.forPublication(publication);
    const [record, configuration] = await Promise.all([
      repository.getPublication(),
      repository.getConfig(),
    ]);
    if (!record || !configuration) {
      throw new AgentRequestError(404, "target_not_found", "没有找到目标日报。");
    }
    return { publication, record, configuration, timeZone: configuration.timeZone };
  }

  async listPublications(context: AgentRequestContext) {
    try {
      const publications = await this.tenancy.forTenant(context.tenant).listPublications();
      return {
        publications: publications.map((publication) => ({
          publicationId: publication.publicationId,
          name: publication.displayName,
          isDefault: publication.isDefault,
          status: publication.status,
          writable: publication.status === "active",
        })),
      };
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  async getDailyContext(context: AgentRequestContext, publicationId: string, requestedDate?: string) {
    try {
      const target = await this.resolvePublication(context, publicationId);
      const today = todayInTimeZone(target.timeZone, this.now());
      const resolvedDate = requestedDate === undefined ? today : requireDate(requestedDate);
      if (resolvedDate > today) {
        throw new AgentRequestError(400, "future_date_not_allowed", "不能使用未来日期的日报目标。");
      }
      const issue = await createPostgresDailyStorage(this.pool, target.publication, {
        submissionDays: this.config.submissionRetentionDays,
      }).readIssue(resolvedDate);
      return {
        publication: {
          publicationId: target.record.publicationId,
          name: target.record.displayName,
          isDefault: target.record.isDefault,
          status: target.record.status,
          writable: target.record.status === "active",
        },
        timeZone: target.timeZone,
        priorityLimits: target.configuration.priorityLimits,
        today,
        resolvedDate,
        issue: issue ? { exists: true, revision: revisionOf(issue) } : { exists: false, revision: null },
        writeRules: {
          contentSchemaVersions: [1, 2],
          maximumItems: this.config.dailyItemLimit,
          historicalConfirmationRequired: resolvedDate < today,
          replaceRequiresExistingIssue: true,
          replaceExpectedRevision: issue ? revisionOf(issue) : null,
        },
      };
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  async getDailyIssue(context: AgentRequestContext, publicationId: string, requestedDate: string) {
    try {
      const target = await this.resolvePublication(context, publicationId);
      const date = requireDate(requestedDate);
      const storage = createPostgresDailyStorage(this.pool, target.publication, {
        submissionDays: this.config.submissionRetentionDays,
      });
      const [issue, compiled] = await Promise.all([storage.readIssue(date), storage.readCompiled(date)]);
      if (!issue || !compiled) {
        if (!issue && !compiled) throw new AgentRequestError(404, "target_not_found", "找不到这期日报。");
        throw new AgentRequestError(503, "service_unavailable", "这期日报暂时无法完整读取。");
      }
      return {
        publicationId: target.record.publicationId,
        date,
        revision: revisionOf(issue),
        issue,
        compiledEdition: compiled,
        pageUrl: this.absolutePath(`/p/${encodeURIComponent(publicationId)}/?date=${encodeURIComponent(date)}`),
      };
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  async submitDailyCandidate(context: AgentRequestContext, input: {
    publicationId: string;
    clientRunId: string;
    mode: "update" | "replace";
    confirmation: DailyConfirmationInput;
    candidate: unknown;
  }) {
    try {
      const target = await this.resolvePublication(context, input.publicationId);
      if (!input.candidate || typeof input.candidate !== "object" || Array.isArray(input.candidate)) {
        throw new AgentRequestError(400, "schema_invalid", "Content Candidate 必须是对象。");
      }
      const items = (input.candidate as Record<string, unknown>).items;
      if (Array.isArray(items) && items.length > this.config.dailyItemLimit) {
        throw new AgentRequestError(400, "schema_invalid", "Content Candidate 条目数量超过上限。");
      }
      const today = todayInTimeZone(target.timeZone, this.now());
      const writePolicy: DailyWritePolicy = {
        today,
        activeCredentialId: context.credentialId,
        historicalDate: input.confirmation.historicalDate,
        replace: input.confirmation.replace,
      };
      const storage = createPostgresDailyStorage(this.pool, target.publication, {
        submissionDays: this.config.submissionRetentionDays,
      });
      const coordinator = createCloudDailyCoordinator({
        storage,
        publicationId: target.publication.publicationId,
        validateCandidate: (candidate) => validateCandidateValue(candidate, {
          filePath: "Content Candidate",
          expectedDate: (candidate as { date?: unknown })?.date,
          validateAsset: async (assetPath: string) => {
            if (!assetPath.startsWith("https://")) throw new TypeError("cloud assets must use HTTPS URLs");
          },
        }),
        createApplicationService: createDailyApplicationService,
      });
      const result = await this.policy.withWriteLease({
        tenant: context.tenant,
        credentialId: context.credentialId,
        requestId: context.requestId,
        concurrentLimit: this.config.concurrentWriteLimitPerSpace,
        ttlSeconds: this.config.writeLeaseTtlSeconds,
      }, () => coordinator.submit({
        clientRunId: input.clientRunId,
        candidate: input.candidate,
        mode: input.mode,
        writePolicy,
      }));
      const date = requireDate((input.candidate as Record<string, unknown>).date);
      return {
        ...result,
        pageUrl: this.absolutePath(`/p/${encodeURIComponent(input.publicationId)}/?date=${encodeURIComponent(date)}`),
      };
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  async getTodoContext(context: AgentRequestContext) {
    try {
      const snapshot = await createPostgresTodoStorage(this.pool, context.tenant, {
        submissionDays: this.config.submissionRetentionDays,
      }).readSnapshot();
      const base = {
        enabled: snapshot.enabled,
        candidateRules: {
          schemaVersion: 1,
          maximumOperations: this.config.todoOperationLimit,
        },
        settingsUrl: this.absolutePath("/settings/sites#personal-todo"),
      };
      return snapshot.enabled ? { ...base, revision: revisionOf(snapshot.state) } : base;
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  async getTodoState(context: AgentRequestContext) {
    try {
      const snapshot = await createPostgresTodoStorage(this.pool, context.tenant, {
        submissionDays: this.config.submissionRetentionDays,
      }).readSnapshot();
      if (!snapshot.enabled) {
        throw new AgentRequestError(409, "todo_disabled", "Personal Todo 尚未启用。");
      }
      const state = snapshot.state;
      return { state, revision: revisionOf(state), pageUrl: this.absolutePath("/todo/") };
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  async getTodo(context: AgentRequestContext) {
    try {
      const snapshot = await createPostgresTodoStorage(this.pool, context.tenant, {
        submissionDays: this.config.submissionRetentionDays,
      }).readSnapshot();
      const base = {
        enabled: snapshot.enabled,
        candidateRules: {
          schemaVersion: 1,
          maximumOperations: this.config.todoOperationLimit,
        },
        settingsUrl: this.absolutePath("/settings/sites#personal-todo"),
      };
      if (!snapshot.enabled) return base;
      return {
        ...base,
        revision: revisionOf(snapshot.state),
        state: snapshot.state,
        pageUrl: this.absolutePath("/todo/"),
      };
    } catch (error) {
      throw mapOperationError(error);
    }
  }

  async submitTodoCandidate(context: AgentRequestContext, input: {
    clientRunId: string;
    candidate: unknown;
  }) {
    try {
      if (!input.candidate || typeof input.candidate !== "object" || Array.isArray(input.candidate)) {
        throw new AgentRequestError(400, "schema_invalid", "Todo Candidate 必须是对象。");
      }
      const operations = (input.candidate as Record<string, unknown>).operations;
      if (Array.isArray(operations) && operations.length > this.config.todoOperationLimit) {
        throw new AgentRequestError(400, "schema_invalid", "Todo Candidate 操作数量超过上限。");
      }
      const storage = createPostgresTodoStorage(this.pool, context.tenant, {
        submissionDays: this.config.submissionRetentionDays,
      });
      const coordinator = createCloudTodoCoordinator({
        storage,
        createApplicationService: (applicationStorage) => createTodoApplicationService(applicationStorage, {
          validateCandidate: validateTodoCandidate,
          validateState: validateTodoState,
          generateId: () => `todo-${randomBytes(4).toString("hex")}`,
          normalizeNow: (value: string | Date | undefined) => {
            const normalized = value instanceof Date ? value.toISOString() : value ?? this.now().toISOString();
            if (typeof normalized !== "string" || Number.isNaN(Date.parse(normalized))) {
              throw new TypeError("now must be a valid timestamp");
            }
            return normalized;
          },
        }),
      });
      const result = await this.policy.withWriteLease({
        tenant: context.tenant,
        credentialId: context.credentialId,
        requestId: context.requestId,
        concurrentLimit: this.config.concurrentWriteLimitPerSpace,
        ttlSeconds: this.config.writeLeaseTtlSeconds,
      }, () => coordinator.submit({
        clientRunId: input.clientRunId,
        candidate: input.candidate,
        activeCredentialId: context.credentialId,
      }));
      if (result.result === "rejected") {
        if (result.field === "baseRevision") {
          throw new AgentRequestError(409, "revision_conflict", "待办已被更新，请重新读取最新状态后再提交。");
        }
        throw new AgentRequestError(400, "schema_invalid", "Todo Candidate 不符合当前状态或 Schema。");
      }
      return { ...result, pageUrl: this.absolutePath("/todo/") };
    } catch (error) {
      throw mapOperationError(error);
    }
  }
}
