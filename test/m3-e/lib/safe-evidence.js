import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const EVIDENCE_ROOT = path.join(PROJECT_ROOT, "test-results", "m3-e");
export const STANDALONE_SCHEDULER = "codex-standalone-cron";

const PRIVATE_MODE_MASK = 0o077;
const REQUEST_ID = /^req_[0-9a-f]{32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID = /^[A-Za-z0-9._-]{8,80}$/;
const PAT = /dnpat_[A-Za-z0-9_-]+/g;
const BEARER = /Bearer\s+[^\s,;]+/gi;
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|credential|session/i;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const SAFE_RESULT = /^(?:created|updated|unchanged|rejected|accepted|disabled|enabled|failed)$/;
const ERROR_CODES = new Set([
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
  "payload_too_large",
  "rate_limited",
  "service_unavailable",
]);
const EXPECTED_TOOLS = new Set([
  "get_daily_context",
  "submit_daily_candidate",
  "get_daily_issue",
  "get_todo_context",
  "submit_todo_candidate",
  "get_todo_state",
]);
const SCHEDULE_PHASES = new Set(["scheduled-repeat", "changed-requirement"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(key) && key !== "sessionId";
}

export class EvidenceInputError extends Error {
  constructor(code) {
    super(code);
    this.name = "EvidenceInputError";
    this.code = code;
  }
}

export function isInside(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function privatePath(filePath, purpose) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new EvidenceInputError(`${purpose}_file_required`);
  }
  const resolved = path.resolve(filePath);
  if (isInside(PROJECT_ROOT, resolved)) {
    throw new EvidenceInputError(`${purpose}_file_must_be_outside_repository`);
  }
  return resolved;
}

async function readPrivateFile(filePath, purpose, maximumBytes) {
  const resolved = privatePath(filePath, purpose);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch {
    throw new EvidenceInputError(`${purpose}_file_unavailable`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new EvidenceInputError(`${purpose}_file_must_be_regular`);
  }
  if ((metadata.mode & PRIVATE_MODE_MASK) !== 0) {
    throw new EvidenceInputError(`${purpose}_file_permissions_must_be_private`);
  }
  if (metadata.size > maximumBytes) {
    throw new EvidenceInputError(`${purpose}_file_too_large`);
  }
  try {
    return { path: resolved, bytes: metadata.size, text: await readFile(resolved, "utf8") };
  } catch {
    throw new EvidenceInputError(`${purpose}_file_unreadable`);
  }
}

export async function readPrivateText(filePath, purpose, maximumBytes = 64 * 1024) {
  return readPrivateFile(filePath, purpose, maximumBytes);
}

export async function readPrivateJson(filePath, purpose, maximumBytes = 256 * 1024) {
  const source = await readPrivateFile(filePath, purpose, maximumBytes);
  let value;
  try {
    value = JSON.parse(source.text);
  } catch {
    throw new EvidenceInputError(`${purpose}_file_invalid_json`);
  }
  rejectSensitiveKeys(value, purpose);
  return { ...source, value };
}

export function rejectSensitiveKeys(value, purpose = "input", depth = 0) {
  if (depth > 20 || value === null || value === undefined) return;
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) rejectSensitiveKeys(entry, purpose, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      throw new EvidenceInputError(`${purpose}_contains_sensitive_field`);
    }
    rejectSensitiveKeys(entry, purpose, depth + 1);
  }
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function validRunId(value) {
  return typeof value === "string" && RUN_ID.test(value) ? value : undefined;
}

export function safeRequestId(value) {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : undefined;
}

export function safeDate(value) {
  return typeof value === "string" && DATE.test(value) ? value : undefined;
}

export function safeIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

export function safeErrorCode(value) {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value) && ERROR_CODES.has(value) ? value : undefined;
}

export function safeRevision(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

export function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function safeTimestamp(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

export function validateScheduleEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceInputError("schedule_event_invalid");
  }
  if (Object.hasOwn(value, "triggerSource") || Object.hasOwn(value, "triggeredAt")) {
    throw new EvidenceInputError("schedule_legacy_field_not_allowed");
  }
  if (value.schedulerType !== STANDALONE_SCHEDULER) {
    throw new EvidenceInputError("scheduler_type_invalid");
  }
  if (typeof value.phase !== "string" || !SCHEDULE_PHASES.has(value.phase)) {
    throw new EvidenceInputError("schedule_phase_invalid");
  }
  if (value.automated !== true || value.manualTrigger !== false) {
    throw new EvidenceInputError("schedule_must_be_automated");
  }
  const scheduledAt = safeTimestamp(value.scheduledAt);
  const startedAt = safeTimestamp(value.startedAt);
  if (!scheduledAt || !startedAt) throw new EvidenceInputError("schedule_timestamp_invalid");
  if (Date.parse(startedAt) < Date.parse(scheduledAt)) {
    throw new EvidenceInputError("task_started_before_schedule");
  }
  const taskId = validRunId(value.taskId);
  const sessionId = validRunId(value.sessionId);
  const mcpRunId = validRunId(value.mcpRunId);
  const requestId = safeRequestId(value.requestId);
  const formalRevision = safeRevision(value.formalRevision);
  if (!taskId || !sessionId || !mcpRunId) throw new EvidenceInputError("schedule_identity_invalid");
  if (!requestId) throw new EvidenceInputError("schedule_request_id_invalid");
  if (formalRevision === undefined || formalRevision < 1) {
    throw new EvidenceInputError("formal_revision_invalid");
  }
  return {
    phase: value.phase,
    schedulerType: STANDALONE_SCHEDULER,
    automated: true,
    manualTrigger: false,
    scheduledAt,
    startedAt,
    taskId,
    sessionId,
    mcpRunId,
    requestId,
    formalRevision,
  };
}

export function redact(value, depth = 0) {
  if (depth > 20) return "[REDACTED_DEPTH]";
  if (typeof value === "string") {
    return value.replace(PAT, "[REDACTED_PAT]").replace(BEARER, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED_SENSITIVE_FIELD]" : redact(entry, depth + 1),
    ]));
  }
  return value;
}

export function safeError(error) {
  const status = safeStatus(error?.status) ?? safeStatus(error?.data?.status);
  return status === undefined
    ? { error: "transport_or_sdk" }
    : { error: "transport_or_sdk", status };
}

export function summarizeToolResult(tool, result) {
  const structured = result && typeof result.structuredContent === "object" && result.structuredContent !== null
    ? result.structuredContent
    : {};
  const summary = {
    tool: safeIdentifier(String(tool).replaceAll("_", "-")) ?? "unknown-tool",
    outcome: result?.isError === true ? "error" : "ok",
  };
  const requestId = safeRequestId(structured.requestId) ?? safeRequestId(structured.error?.requestId);
  if (requestId) summary.requestId = requestId;
  const errorCode = safeErrorCode(structured.error?.code);
  if (errorCode) summary.errorCode = errorCode;
  if (SAFE_RESULT.test(structured.result)) summary.result = structured.result;
  for (const field of ["publicationId", "date", "resolvedDate"]) {
    const value = field.endsWith("Date") ? safeDate(structured[field]) : safeIdentifier(structured[field]);
    if (value) summary[field] = value;
  }
  for (const field of ["revision", "operationCount"]) {
    const value = safeRevision(structured[field]);
    if (value !== undefined) summary[field] = value;
  }
  if (typeof structured.enabled === "boolean") summary.enabled = structured.enabled;
  const issueRevision = safeRevision(structured.issue?.revision);
  if (issueRevision !== undefined) summary.issueRevision = issueRevision;
  const compiledRevision = safeRevision(structured.compiledEdition?.revision);
  if (compiledRevision !== undefined) summary.compiledRevision = compiledRevision;
  return summary;
}

export function summarizeResponse(response) {
  const requestId = safeRequestId(response?.headers?.get("x-request-id"));
  return {
    status: safeStatus(response?.status) ?? 0,
    ...(requestId ? { requestId } : {}),
    sessionHeaderPresent: response?.headers?.has("mcp-session-id") === true,
    cacheControlPrivate: response?.headers?.get("cache-control") === "private, no-store",
    corsHeaderPresent: response?.headers?.has("access-control-allow-origin") === true,
  };
}

export function summarizeTools(tools) {
  const names = Array.isArray(tools)
    ? tools.map((tool) => tool?.name).filter((name) => typeof name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(name))
    : [];
  const expectedNames = names.filter((name) => EXPECTED_TOOLS.has(name));
  return {
    count: names.length,
    names: expectedNames,
    unexpectedCount: names.length - expectedNames.length,
    expectedSixTools: expectedNames.length === 6 && new Set(expectedNames).size === 6 && names.length === 6,
  };
}

export function outputFileFor(runId) {
  const valid = validRunId(runId);
  if (!valid) throw new EvidenceInputError("run_id_invalid");
  return path.join(EVIDENCE_ROOT, `${valid}.json`);
}

export async function writeEvidence(runId, evidence) {
  const target = outputFileFor(runId);
  const safeEvidence = redact(evidence);
  const serialized = `${JSON.stringify(safeEvidence, null, 2)}\n`;
  if (/dnpat_[A-Za-z0-9_-]+|Bearer\s+[^\s,;]+/i.test(serialized)) {
    throw new EvidenceInputError("evidence_contains_credential_material");
  }
  await mkdir(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  return path.relative(PROJECT_ROOT, target);
}
