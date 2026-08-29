import * as z from "zod/v4";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLIENT_RUN_ID = /^[A-Za-z0-9._-]{8,80}$/;
const TODO_ID = /^todo-[a-f0-9]{8}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const date = z.string().regex(DATE).describe("Calendar date in YYYY-MM-DD format.");
const identifier = z.string().regex(IDENTIFIER);
const timestamp = z.string().regex(ISO_TIMESTAMP).describe("ISO 8601 timestamp with an explicit time zone.");
const httpUrl = z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"));
const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"));

const sourceVia = z.object({
  name: z.string().min(1),
  url: httpUrl,
}).strict();

const source = z.object({
  originalTitle: z.string().min(1).optional(),
  name: z.string().min(1),
  url: httpUrl,
  publishedAt: timestamp.optional(),
  discoveredAt: timestamp.optional(),
  via: sourceVia.optional(),
}).strict();

const image = z.object({
  src: httpsUrl,
  alt: z.string().min(1).max(160),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  credit: z.string().min(1).max(120),
  sourceUrl: httpUrl.optional(),
}).strict();

const contentItem = z.object({
  id: identifier,
  title: z.string().min(1),
  brief: z.string().min(1),
  summary: z.string().min(1),
  category: z.string().min(1).optional(),
  editorial: z.object({
    priority: z.enum(["lead", "important", "normal"]),
    selectionReason: z.string().min(1),
  }).strict(),
  sources: z.array(source).min(1),
  image: image.optional(),
}).strict();

export const contentCandidateSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  date,
  generatedAt: timestamp,
  coverage: z.object({ start: timestamp, end: timestamp }).strict(),
  items: z.array(contentItem).min(1),
}).strict();

const todoEditable = {
  title: z.string().min(1).max(120),
  note: z.string().min(1).max(500).optional(),
  dueDate: date.optional(),
  dueTime: z.string().regex(TIME).optional(),
};

const todoChanges = z.object({
  title: todoEditable.title.optional(),
  note: z.union([z.string().min(1).max(500), z.null()]).optional(),
  dueDate: z.union([date, z.null()]).optional(),
  dueTime: z.union([z.string().regex(TIME), z.null()]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "changes must contain at least one field");

const todoOperation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), clientId: z.string().min(1), ...todoEditable }).strict(),
  z.object({ type: z.literal("update"), taskId: z.string().regex(TODO_ID), changes: todoChanges }).strict(),
  z.object({ type: z.literal("complete"), taskId: z.string().regex(TODO_ID) }).strict(),
  z.object({ type: z.literal("reopen"), taskId: z.string().regex(TODO_ID) }).strict(),
  z.object({ type: z.literal("archive"), taskId: z.string().regex(TODO_ID) }).strict(),
  z.object({ type: z.literal("restore"), taskId: z.string().regex(TODO_ID) }).strict(),
]);

export const todoCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  candidateId: identifier,
  generatedAt: timestamp,
  baseRevision: z.number().int().min(0),
  operations: z.array(todoOperation).min(1),
}).strict();

export const getDailyContextInputSchema = z.object({
  publicationId: identifier.optional().describe("Target Publication. Omit to use the authenticated Space default."),
  date: date.optional().describe("Target date. Omit to use today in the Publication time zone."),
}).strict();

export const submitDailyCandidateInputSchema = z.object({
  publicationId: identifier,
  clientRunId: z.string().regex(CLIENT_RUN_ID).describe("Stable idempotency key. Reuse only for an exact retry."),
  mode: z.enum(["update", "replace"]),
  confirmation: z.object({
    historicalDate: z.union([date, z.null()]),
    replace: z.union([
      z.object({
        publicationId: identifier,
        date,
        expectedRevision: z.number().int().min(1),
      }).strict(),
      z.null(),
    ]),
  }).strict(),
  candidate: contentCandidateSchema,
}).strict();

export function createSubmitDailyCandidateInputSchema(maximumItems: number) {
  return submitDailyCandidateInputSchema.extend({
    candidate: contentCandidateSchema.extend({
      items: contentCandidateSchema.shape.items.max(maximumItems),
    }),
  });
}

export const getDailyIssueInputSchema = z.object({
  publicationId: identifier,
  date,
}).strict();

export const emptyInputSchema = z.object({}).strict();

const themeColors = z.object({
  background: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  text: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  muted: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  rule: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
}).strict();

const themeTypography = z.object({
  headlinePreset: z.enum(["serif-cn", "sans-cn", "mono"]).optional(),
  uiPreset: z.enum(["serif-cn", "sans-cn", "mono"]).optional(),
  headlineScale: z.enum(["restrained", "editorial", "poster"]).optional(),
}).strict();

export const agentThemeSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  name: z.string().min(1).refine((value) => value === value.trim() && [...value].length <= 40),
  description: z.string().min(1).optional(),
  extends: identifier,
  tokens: z.object({
    colors: themeColors.optional(),
    typography: themeTypography.optional(),
    density: z.enum(["compact", "balanced", "spacious"]).optional(),
    ruleStyle: z.enum(["hairline", "strong", "double"]).optional(),
    surfaceStyle: z.enum(["flat", "paper", "soft-gradient"]).optional(),
    motion: z.enum(["none", "subtle"]).optional(),
  }).strict(),
  recipes: z.object({
    masthead: z.enum(["compact", "classic", "banner"]).optional(),
    lead: z.enum(["split", "stacked", "editorial"]).optional(),
    important: z.enum(["ruled", "minimal", "contrast"]).optional(),
    normal: z.enum(["compact", "minimal", "accent"]).optional(),
  }).strict(),
}).strict().refine((value) => (
  Object.keys(value.tokens).length + Object.keys(value.recipes).length > 0
), "tokens and recipes must contain at least one override");

export const getThemeInputSchema = z.object({ themeId: identifier }).strict();
export const createThemeInputSchema = z.object({
  clientRunId: z.string().regex(CLIENT_RUN_ID),
  theme: agentThemeSchema,
}).strict();
export const updateThemeInputSchema = z.object({
  themeId: identifier,
  clientRunId: z.string().regex(CLIENT_RUN_ID),
  baseRevision: z.number().int().min(1),
  theme: agentThemeSchema,
}).strict();
export const deleteThemeInputSchema = z.object({
  themeId: identifier,
  clientRunId: z.string().regex(CLIENT_RUN_ID),
  baseRevision: z.number().int().min(1),
}).strict();

export const submitTodoCandidateInputSchema = z.object({
  clientRunId: z.string().regex(CLIENT_RUN_ID).describe("Stable idempotency key. Reuse only for an exact retry."),
  candidate: todoCandidateSchema,
}).strict();

export function createSubmitTodoCandidateInputSchema(maximumOperations: number) {
  return submitTodoCandidateInputSchema.extend({
    candidate: todoCandidateSchema.extend({
      operations: todoCandidateSchema.shape.operations.max(maximumOperations),
    }),
  });
}

const requestId = z.string().regex(/^req_[0-9a-f]{32}$/);

const compilationWarning = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("priority"), date, itemId: identifier,
    sourcePriority: z.enum(["lead", "important", "normal"]),
    compiledPriority: z.enum(["lead", "important", "normal"]),
    reason: z.string(),
  }).strict(),
  z.object({
    type: z.literal("length"), date, itemId: identifier, field: z.string(),
    length: z.number().int().min(0), limit: z.number().int().min(0),
    priority: z.enum(["lead", "important", "normal"]).optional(),
  }).strict(),
  z.object({
    type: z.literal("length-range"), date, itemId: identifier, field: z.string(),
    length: z.number().int().min(0), min: z.number().int().min(0), max: z.number().int().min(0),
  }).strict(),
  z.object({ type: z.literal("image"), date, itemId: identifier }).strict(),
  z.object({
    type: z.literal("layout"), date, usedCapacity: z.number().int().min(0).max(4),
    nextItemId: identifier, reason: z.string(),
  }).strict(),
]);

const formalIssue = contentCandidateSchema.extend({
  revision: z.number().int().min(1),
});

const compiledEdition = formalIssue.extend({
  layout: z.object({
    rows: z.array(z.object({
      usedCapacity: z.number().int().min(1).max(4),
      modules: z.array(z.object({
        itemId: identifier,
        resolvedPriority: z.enum(["lead", "important", "normal"]),
        size: z.enum(["large", "medium", "small"]),
        span: z.union([z.literal(1), z.literal(2), z.literal(4)]),
        mediaVariant: z.enum(["lead-split", "medium-split", "none"]).optional(),
      }).strict()).min(1),
    }).strict()).min(1),
  }).strict(),
});

const todoState = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0),
  updatedAt: z.union([timestamp, z.null()]),
  items: z.array(z.object({
    id: z.string().regex(TODO_ID),
    title: z.string().min(1).max(120),
    note: z.string().min(1).max(500).optional(),
    dueDate: date.optional(),
    dueTime: z.string().regex(TIME).optional(),
    status: z.enum(["open", "completed", "archived"]),
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: z.union([timestamp, z.null()]),
    archivedAt: z.union([timestamp, z.null()]),
  }).strict()),
}).strict();

export const errorOutputSchema = z.object({
  error: z.object({
    code: z.enum([
      "invalid_request",
      "schema_invalid",
      "future_date_not_allowed",
      "invalid_token",
      "target_not_found",
      "idempotency_conflict",
      "revision_conflict",
      "explicit_confirmation_required",
      "publication_inactive",
      "todo_disabled",
      "theme_conflict",
      "theme_read_only",
      "theme_in_use",
      "theme_limit_reached",
      "payload_too_large",
      "rate_limited",
      "service_unavailable",
    ]),
    message: z.string(),
    requestId,
    retryAfterSeconds: z.number().int().min(1).optional(),
  }).strict(),
}).strict();

function resultOutputSchema(success: z.ZodType) {
  return z.union([
    success,
    errorOutputSchema,
  ]);
}

const publication = z.object({
  publicationId: identifier,
  name: z.string().min(1),
  isDefault: z.boolean(),
  status: z.enum(["active", "inactive"]),
  writable: z.boolean(),
}).strict();

export const dailyContextOutputSchema = resultOutputSchema(z.object({
  publication,
  timeZone: z.string().min(1),
  priorityLimits: z.object({
    lead: z.number().int().min(0),
    important: z.number().int().min(0),
    normal: z.union([z.number().int().min(0), z.null()]),
  }).strict(),
  today: date,
  resolvedDate: date,
  issue: z.object({
    exists: z.boolean(),
    revision: z.union([z.number().int().min(1), z.null()]),
  }).strict(),
  writeRules: z.object({
    contentSchemaVersions: z.tuple([z.literal(1), z.literal(2)]),
    maximumItems: z.number().int().min(1),
    historicalConfirmationRequired: z.boolean(),
    replaceRequiresExistingIssue: z.literal(true),
    replaceExpectedRevision: z.union([z.number().int().min(1), z.null()]),
  }).strict(),
  availablePublications: z.array(publication),
  requestId,
}).strict());

export const dailySubmissionOutputSchema = resultOutputSchema(z.object({
  result: z.enum(["created", "updated", "unchanged"]),
  publicationId: identifier,
  date,
  revision: z.number().int().min(1),
  mode: z.enum(["update", "replace"]).optional(),
  repaired: z.array(z.enum(["compiled", "index"])).optional(),
  warnings: z.array(compilationWarning),
  pageUrl: httpUrl,
  requestId,
}).strict());

export const dailyIssueOutputSchema = resultOutputSchema(z.object({
  publicationId: identifier,
  date,
  revision: z.number().int().min(1),
  issue: formalIssue,
  compiledEdition,
  pageUrl: httpUrl,
  requestId,
}).strict());

export const todoContextOutputSchema = resultOutputSchema(z.object({
  enabled: z.boolean(),
  candidateRules: z.object({
    schemaVersion: z.literal(1),
    maximumOperations: z.number().int().min(1),
  }).strict(),
  settingsUrl: httpUrl,
  revision: z.number().int().min(0).optional(),
  requestId,
}).strict());

export const todoSubmissionOutputSchema = resultOutputSchema(z.object({
  schemaVersion: z.literal(1),
  candidateId: identifier,
  result: z.enum(["published", "unchanged"]),
  baseRevision: z.number().int().min(0),
  revision: z.number().int().min(0),
  operationCount: z.number().int().min(1),
  operations: z.array(z.object({
    index: z.number().int().min(0),
    type: z.enum(["add", "update", "complete", "reopen", "archive", "restore"]),
    result: z.enum(["created", "updated", "unchanged"]),
    clientId: z.string().optional(),
    taskId: z.string(),
  }).strict()),
  warnings: z.tuple([]),
  processedAt: timestamp,
  pageUrl: httpUrl,
  requestId,
}).strict());

export const todoStateOutputSchema = resultOutputSchema(z.object({
  state: todoState,
  revision: z.number().int().min(0),
  pageUrl: httpUrl,
  requestId,
}).strict());

const themeUsage = z.object({
  home: z.boolean(),
  publications: z.array(z.object({
    publicationId: identifier,
    name: z.string().min(1),
    mode: z.enum(["inherit", "override"]),
    status: z.enum(["active", "inactive"]),
  }).strict()),
}).strict();

const themeSummary = z.object({
  themeId: identifier,
  name: z.string().min(1),
  source: z.enum(["official", "custom"]),
  revision: z.number().int().min(1),
  usage: themeUsage,
}).strict();

export const themeContextOutputSchema = resultOutputSchema(z.object({
  themeSchema: z.object({
    schemaVersion: z.literal(1),
    idPattern: z.string(),
    name: z.object({ minimumVisibleCharacters: z.literal(1), maximumVisibleCharacters: z.literal(40) }).strict(),
    colors: z.object({ format: z.literal("#RRGGBB"), minimumTextContrast: z.literal(4.5) }).strict(),
    enums: z.record(z.string(), z.array(z.string())),
    forbidden: z.array(z.string()),
  }).strict(),
  constraints: z.object({
    customThemeLimit: z.number().int().min(1),
    customThemeCount: z.number().int().min(0),
    officialThemesReadOnly: z.literal(true),
    selectionManagedInBrowser: z.literal(true),
    baseRevisionRequiredForUpdateAndDelete: z.literal(true),
  }).strict(),
  themes: z.array(themeSummary),
  requestId,
}).strict());

export const themeOutputSchema = resultOutputSchema(themeSummary.extend({
  definition: z.record(z.string(), z.unknown()),
  requestId,
}).strict());

export const themeMutationOutputSchema = resultOutputSchema(z.object({
  result: z.enum(["created", "updated", "unchanged", "deleted"]),
  themeId: identifier,
  revision: z.number().int().min(1),
  affected: themeUsage,
  requestId,
}).strict());
