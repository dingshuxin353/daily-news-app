import { cloneValue, sameValue } from "./value.js";

export class TodoDomainError extends Error {
  constructor(field, message, result = "rejected") {
    super(`${field} ${message}`);
    this.name = "TodoDomainError";
    this.field = field;
    this.result = result;
  }
}

function nowValue(now) {
  const value = now instanceof Date ? now.toISOString() : now;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TodoDomainError("now", "必须是合法时间");
  }
  return value;
}

function createTaskId(items, generateId) {
  if (typeof generateId !== "function") {
    throw new TodoDomainError("id", "必须由宿主提供正式 Todo ID 生成器");
  }
  const ids = new Set(items.map(({ id }) => id));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = generateId();
    if (/^todo-[a-f0-9]{8}$/.test(id) && !ids.has(id)) return id;
  }
  throw new TodoDomainError("id", "无法生成唯一正式 Todo ID");
}

function findTask(state, taskId, operationIndex) {
  const task = state.items.find(({ id }) => id === taskId);
  if (!task) throw new TodoDomainError(`operations.${operationIndex}.taskId`, "不存在");
  return task;
}

function normalizeEditable(operation) {
  const output = { title: operation.title.trim() };
  if ("note" in operation) output.note = operation.note.trim();
  if ("dueDate" in operation) output.dueDate = operation.dueDate;
  if ("dueTime" in operation) output.dueTime = operation.dueTime;
  return output;
}

function applyUpdate(task, changes, timestamp, operationIndex) {
  const before = cloneValue(task);
  if ("title" in changes) task.title = changes.title.trim();
  if ("note" in changes) {
    if (changes.note === null) delete task.note;
    else task.note = changes.note.trim();
  }
  if ("dueDate" in changes) {
    if (changes.dueDate === null) {
      delete task.dueDate;
      delete task.dueTime;
    } else {
      task.dueDate = changes.dueDate;
    }
  }
  if ("dueTime" in changes) {
    if (changes.dueTime === null) delete task.dueTime;
    else task.dueTime = changes.dueTime;
  }
  if ("dueTime" in task && !("dueDate" in task)) {
    throw new TodoDomainError(`operations.${operationIndex}.changes.dueTime`, "只有存在 dueDate 时才允许");
  }
  if (sameValue(before, task)) return false;
  task.updatedAt = timestamp;
  return true;
}

export function planTodoCandidate(state, candidate, options = {}) {
  if (candidate.baseRevision !== state.revision) {
    throw new TodoDomainError("baseRevision", `revision conflict：当前为 ${state.revision}`);
  }
  const timestamp = nowValue(options.now);
  const next = cloneValue(state);
  const operationResults = [];
  let changed = false;

  candidate.operations.forEach((operation, index) => {
    if (operation.type === "add") {
      const id = createTaskId(next.items, options.generateId);
      next.items.push({
        id,
        ...normalizeEditable(operation),
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        archivedAt: null,
      });
      operationResults.push({ index, type: "add", result: "created", clientId: operation.clientId, taskId: id });
      changed = true;
      return;
    }

    const task = findTask(next, operation.taskId, index);
    if (operation.type === "update") {
      const updated = applyUpdate(task, operation.changes, timestamp, index);
      operationResults.push({ index, type: "update", result: updated ? "updated" : "unchanged", taskId: task.id });
      changed ||= updated;
      return;
    }
    if (operation.type === "complete") {
      if (task.status === "completed") {
        operationResults.push({ index, type: "complete", result: "unchanged", taskId: task.id });
        return;
      }
      if (task.status !== "open") {
        throw new TodoDomainError(`operations.${index}.taskId`, "归档任务不能直接完成");
      }
      task.status = "completed";
      task.completedAt = timestamp;
      task.updatedAt = timestamp;
    } else if (operation.type === "reopen") {
      if (task.status !== "completed") {
        throw new TodoDomainError(`operations.${index}.taskId`, "只有已完成任务可以重新打开");
      }
      task.status = "open";
      task.completedAt = null;
      task.updatedAt = timestamp;
    } else if (operation.type === "archive") {
      if (task.status === "archived") {
        operationResults.push({ index, type: "archive", result: "unchanged", taskId: task.id });
        return;
      }
      task.status = "archived";
      task.archivedAt = timestamp;
      task.updatedAt = timestamp;
    } else if (operation.type === "restore") {
      if (task.status !== "archived") {
        throw new TodoDomainError(`operations.${index}.taskId`, "只有已归档任务可以恢复");
      }
      task.status = "open";
      task.archivedAt = null;
      task.completedAt = null;
      task.updatedAt = timestamp;
    }
    operationResults.push({ index, type: operation.type, result: "updated", taskId: task.id });
    changed = true;
  });

  if (changed) {
    next.revision = state.revision + 1;
    next.updatedAt = timestamp;
  }
  options.validateState?.(next);
  return { result: changed ? "published" : "unchanged", state: next, operationResults };
}
