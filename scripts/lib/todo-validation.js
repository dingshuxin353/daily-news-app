import { readFile } from "node:fs/promises";
import path from "node:path";

const candidateIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const taskIdPattern = /^todo-[a-f0-9]{8}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class TodoError extends Error {
  constructor(field, message, result = "rejected") {
    super(`${field} ${message}`);
    this.name = "TodoError";
    this.field = field;
    this.result = result;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, field) {
  if (!isObject(value)) throw new TodoError(field, "必须是对象");
}

function assertExactKeys(value, allowed, field) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new TodoError(`${field}.${extras[0]}`, "是不允许的字段");
}

function codePointLength(value) {
  return [...value].length;
}

function assertText(value, field, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string") throw new TodoError(field, "必须是字符串");
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TodoError(field, "不能为空");
  if (codePointLength(trimmed) > maximum) {
    throw new TodoError(field, `不能超过 ${maximum} 个字符`);
  }
}

function assertTimestamp(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !timestampPattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TodoError(field, "必须是带时区的 ISO 8601 时间");
  }
}

function assertDate(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !datePattern.test(value)) {
    throw new TodoError(field, "必须是 YYYY-MM-DD 日期");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TodoError(field, "必须是真实日历日期");
  }
}

function assertTime(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !timePattern.test(value)) {
    throw new TodoError(field, "必须是 HH:mm 时间");
  }
}

function validateEditableFields(value, field, { update = false } = {}) {
  if (update) assertExactKeys(value, ["title", "note", "dueDate", "dueTime"], field);
  if (!update || "title" in value) assertText(value.title, `${field}.title`, 120);
  if ("note" in value) assertText(value.note, `${field}.note`, 500, { nullable: update });
  if ("dueDate" in value) assertDate(value.dueDate, `${field}.dueDate`, { nullable: update });
  if ("dueTime" in value) assertTime(value.dueTime, `${field}.dueTime`, { nullable: update });
  if (!update && "dueTime" in value && !("dueDate" in value)) {
    throw new TodoError(`${field}.dueTime`, "只有存在 dueDate 时才允许");
  }
  if (update && value.dueDate === null && value.dueTime !== undefined && value.dueTime !== null) {
    throw new TodoError(`${field}.dueTime`, "清除 dueDate 时不能保留 dueTime");
  }
}

function validateOperation(operation, index, clientIds, taskIds) {
  const field = `operations.${index}`;
  assertObject(operation, field);
  if (typeof operation.type !== "string") throw new TodoError(`${field}.type`, "必须是字符串");
  if (operation.type === "add") {
    assertExactKeys(operation, ["type", "clientId", "title", "note", "dueDate", "dueTime"], field);
    if (typeof operation.clientId !== "string" || operation.clientId.trim().length === 0) {
      throw new TodoError(`${field}.clientId`, "必须是非空字符串");
    }
    if (clientIds.has(operation.clientId)) throw new TodoError(`${field}.clientId`, "在当前 Candidate 中重复");
    clientIds.add(operation.clientId);
    validateEditableFields(operation, field);
    return;
  }
  if (operation.type === "update") {
    assertExactKeys(operation, ["type", "taskId", "changes"], field);
    assertTaskId(operation.taskId, `${field}.taskId`);
    assertObject(operation.changes, `${field}.changes`);
    if (Object.keys(operation.changes).length === 0) {
      throw new TodoError(`${field}.changes`, "必须至少包含一个字段");
    }
    validateEditableFields(operation.changes, `${field}.changes`, { update: true });
  } else if (["complete", "reopen", "archive", "restore"].includes(operation.type)) {
    assertExactKeys(operation, ["type", "taskId"], field);
    assertTaskId(operation.taskId, `${field}.taskId`);
  } else {
    throw new TodoError(`${field}.type`, "必须是 add、update、complete、reopen、archive 或 restore");
  }
  if (taskIds.has(operation.taskId)) throw new TodoError(`${field}.taskId`, "不能在同一 Candidate 中重复操作");
  taskIds.add(operation.taskId);
}

function assertTaskId(value, field) {
  if (typeof value !== "string" || !taskIdPattern.test(value)) {
    throw new TodoError(field, "必须是合法的正式 Todo ID");
  }
}

export function validateTodoConfig(value, filePath = "config/todo.json") {
  assertObject(value, filePath);
  assertExactKeys(value, ["schemaVersion", "enabled"], filePath);
  if (value.schemaVersion !== 1) throw new TodoError(`${filePath}.schemaVersion`, "必须是整数 1");
  if (typeof value.enabled !== "boolean") throw new TodoError(`${filePath}.enabled`, "必须是布尔值");
  return value;
}

export async function loadTodoConfig(rootDir) {
  const filePath = path.join(rootDir, "config", "todo.json");
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new TodoError(filePath, "不存在");
    if (error instanceof SyntaxError) throw new TodoError(filePath, "不是合法 JSON");
    throw error;
  }
  return validateTodoConfig(value, filePath);
}

export function validateTodoCandidate(value, filePath = "Todo Candidate") {
  assertObject(value, filePath);
  assertExactKeys(value, ["schemaVersion", "candidateId", "generatedAt", "baseRevision", "operations"], filePath);
  if (value.schemaVersion !== 1) throw new TodoError(`${filePath}.schemaVersion`, "必须是整数 1");
  if (typeof value.candidateId !== "string" || !candidateIdPattern.test(value.candidateId)) {
    throw new TodoError(`${filePath}.candidateId`, "只能使用小写字母、数字和连字符");
  }
  assertTimestamp(value.generatedAt, `${filePath}.generatedAt`);
  if (!Number.isInteger(value.baseRevision) || value.baseRevision < 0) {
    throw new TodoError(`${filePath}.baseRevision`, "必须是非负整数");
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw new TodoError(`${filePath}.operations`, "必须是非空数组");
  }
  const clientIds = new Set();
  const taskIds = new Set();
  value.operations.forEach((operation, index) => validateOperation(operation, index, clientIds, taskIds));
  return value;
}

export function validateTodoState(value, filePath = "todo/data/state.json") {
  assertObject(value, filePath);
  assertExactKeys(value, ["schemaVersion", "revision", "updatedAt", "items"], filePath);
  if (value.schemaVersion !== 1) throw new TodoError(`${filePath}.schemaVersion`, "必须是整数 1");
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    throw new TodoError(`${filePath}.revision`, "必须是非负整数");
  }
  assertTimestamp(value.updatedAt, `${filePath}.updatedAt`, { nullable: true });
  if (!Array.isArray(value.items)) throw new TodoError(`${filePath}.items`, "必须是数组");
  if (value.revision === 0 && (value.updatedAt !== null || value.items.length !== 0)) {
    throw new TodoError(filePath, "revision 0 只能表示空状态");
  }
  if (value.revision > 0 && value.updatedAt === null) {
    throw new TodoError(`${filePath}.updatedAt`, "有效写入后不能为空");
  }
  const ids = new Set();
  value.items.forEach((item, index) => {
    const field = `${filePath}.items.${index}`;
    assertObject(item, field);
    assertExactKeys(item, [
      "id", "title", "note", "dueDate", "dueTime", "status",
      "createdAt", "updatedAt", "completedAt", "archivedAt",
    ], field);
    assertTaskId(item.id, `${field}.id`);
    if (ids.has(item.id)) throw new TodoError(`${field}.id`, "不能重复");
    ids.add(item.id);
    assertText(item.title, `${field}.title`, 120);
    if ("note" in item) assertText(item.note, `${field}.note`, 500);
    if ("dueDate" in item) assertDate(item.dueDate, `${field}.dueDate`);
    if ("dueTime" in item) assertTime(item.dueTime, `${field}.dueTime`);
    if ("dueTime" in item && !("dueDate" in item)) throw new TodoError(`${field}.dueTime`, "只有存在 dueDate 时才允许");
    if (!["open", "completed", "archived"].includes(item.status)) {
      throw new TodoError(`${field}.status`, "必须是 open、completed 或 archived");
    }
    assertTimestamp(item.createdAt, `${field}.createdAt`);
    assertTimestamp(item.updatedAt, `${field}.updatedAt`);
    assertTimestamp(item.completedAt, `${field}.completedAt`, { nullable: true });
    assertTimestamp(item.archivedAt, `${field}.archivedAt`, { nullable: true });
    if (item.status === "open" && (item.completedAt !== null || item.archivedAt !== null)) {
      throw new TodoError(field, "open 状态的完成和归档时间必须为空");
    }
    if (item.status === "completed" && (item.completedAt === null || item.archivedAt !== null)) {
      throw new TodoError(field, "completed 状态必须有完成时间且不能有归档时间");
    }
    if (item.status === "archived" && item.archivedAt === null) {
      throw new TodoError(field, "archived 状态必须有归档时间");
    }
  });
  return value;
}
