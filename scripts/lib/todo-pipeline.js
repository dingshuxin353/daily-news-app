import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  loadTodoConfig,
  TodoError,
  validateTodoCandidate,
  validateTodoState,
} from "./todo-validation.js";

const candidateFilenamePattern = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;

function clone(value) {
  return structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function emptyState() {
  return { schemaVersion: 1, revision: 0, updatedAt: null, items: [] };
}

function nowValue(now) {
  const value = now instanceof Date ? now.toISOString() : now ?? new Date().toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TodoError("now", "必须是合法时间");
  }
  return value;
}

async function writeJsonExclusive(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

export async function ensureTodoData(rootDir) {
  await loadTodoConfig(rootDir);
  const dataDir = path.join(rootDir, "todo", "data");
  await Promise.all([
    mkdir(path.join(dataDir, "candidates"), { recursive: true }),
    mkdir(path.join(dataDir, "submissions"), { recursive: true }),
    mkdir(path.join(dataDir, ".locks"), { recursive: true }),
  ]);
  const resolvedRoot = await realpath(rootDir);
  for (const relativePath of ["todo/data", "todo/data/candidates", "todo/data/submissions", "todo/data/.locks"]) {
    const expected = path.join(resolvedRoot, ...relativePath.split("/"));
    const resolved = await realpath(path.join(rootDir, ...relativePath.split("/")));
    if (resolved !== expected) throw new TodoError(relativePath, "不能通过符号链接越过项目目录");
  }
  const statePath = path.join(dataDir, "state.json");
  try {
    await writeJsonExclusive(statePath, emptyState());
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stateMetadata = await lstat(statePath);
  if (!stateMetadata.isFile() || stateMetadata.isSymbolicLink()) {
    throw new TodoError("state", "必须是 Todo 数据目录内的普通文件");
  }
  return { dataDir, statePath };
}

export async function readTodoState(rootDir) {
  const { statePath } = await ensureTodoData(rootDir);
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TodoError("state", "不是合法 JSON");
    throw error;
  }
  return validateTodoState(state, statePath);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new TodoError(filePath, "不是合法 JSON");
    throw error;
  }
}

async function acquireTodoLock(dataDir) {
  const lockPath = path.join(dataDir, ".locks", "todo.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "EEXIST") throw new TodoError("lock", "已有 Todo 写入流程正在执行");
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  await handle.close();
  return async () => {
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
}

async function stageJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  const previous = await readFile(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  return { targetPath, temporaryPath, previous };
}

async function restoreStage(stage) {
  if (stage.previous === null) {
    await unlink(stage.targetPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  const restorePath = `${stage.targetPath}.${randomUUID()}.restore`;
  await writeFile(restorePath, stage.previous, { flag: "wx" });
  await rename(restorePath, stage.targetPath);
}

async function commitStages(stages) {
  const committed = [];
  try {
    for (const stage of stages) {
      await rename(stage.temporaryPath, stage.targetPath);
      committed.push(stage);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const stage of committed.reverse()) {
      try {
        await restoreStage(stage);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Todo 事务提交失败且回滚不完整");
    }
    throw error;
  } finally {
    await Promise.all(stages.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
  }
}

function createTaskId(items, generateId) {
  const ids = new Set(items.map(({ id }) => id));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = generateId ? generateId() : `todo-${randomBytes(4).toString("hex")}`;
    if (/^todo-[a-f0-9]{8}$/.test(id) && !ids.has(id)) return id;
  }
  throw new TodoError("id", "无法生成唯一正式 Todo ID");
}

function findTask(state, taskId, operationIndex) {
  const task = state.items.find(({ id }) => id === taskId);
  if (!task) throw new TodoError(`operations.${operationIndex}.taskId`, "不存在");
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
  const before = clone(task);
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
    throw new TodoError(`operations.${operationIndex}.changes.dueTime`, "只有存在 dueDate 时才允许");
  }
  if (sameValue(before, task)) return false;
  task.updatedAt = timestamp;
  return true;
}

export function planTodoCandidate(state, candidate, options = {}) {
  if (candidate.baseRevision !== state.revision) {
    throw new TodoError("baseRevision", `revision conflict：当前为 ${state.revision}`);
  }
  const timestamp = nowValue(options.now);
  const next = clone(state);
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
      if (task.status !== "open") throw new TodoError(`operations.${index}.taskId`, "归档任务不能直接完成");
      task.status = "completed";
      task.completedAt = timestamp;
      task.updatedAt = timestamp;
    } else if (operation.type === "reopen") {
      if (task.status !== "completed") throw new TodoError(`operations.${index}.taskId`, "只有已完成任务可以重新打开");
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
      if (task.status !== "archived") throw new TodoError(`operations.${index}.taskId`, "只有已归档任务可以恢复");
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
  validateTodoState(next);
  return { result: changed ? "published" : "unchanged", state: next, operationResults };
}

function rejectedStatus(candidateId, operationCount, state, error, processedAt) {
  return {
    schemaVersion: 1,
    candidateId,
    result: "rejected",
    revision: state.revision,
    operationCount,
    field: error.field ?? null,
    reason: String(error.message ?? "Todo Candidate 处理失败"),
    processedAt,
  };
}

export async function processTodoCandidate(rootDir, candidatePath, options = {}) {
  const { dataDir, statePath } = await ensureTodoData(rootDir);
  const resolvedCandidate = await realpath(path.resolve(candidatePath));
  const candidateDir = await realpath(path.join(dataDir, "candidates"));
  if (path.dirname(resolvedCandidate) !== candidateDir) {
    throw new TodoError("candidate", "必须位于 todo/data/candidates/ 目录");
  }
  const filenameCandidateId = candidateFilenamePattern.exec(path.basename(resolvedCandidate))?.[1];
  if (!filenameCandidateId) throw new TodoError("candidate", "文件名必须是 <candidate-id>.json");

  const releaseLock = await acquireTodoLock(dataDir);
  try {
    const submissionPath = path.join(dataDir, "submissions", `${filenameCandidateId}.json`);
    const submissionMetadata = await lstat(submissionPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (submissionMetadata?.isSymbolicLink() || (submissionMetadata && !submissionMetadata.isFile())) {
      throw new TodoError("submission", "必须是 Todo 数据目录内的普通文件");
    }
    const existingSubmission = await readJsonIfPresent(submissionPath);
    if (existingSubmission) return existingSubmission;

    const state = await readTodoState(rootDir);
    const processedAt = nowValue(options.now);
    let candidate;
    let plan;
    try {
      candidate = JSON.parse(await readFile(resolvedCandidate, "utf8"));
      validateTodoCandidate(candidate, "candidate");
      if (candidate.candidateId !== filenameCandidateId) {
        throw new TodoError("candidateId", "必须与文件名一致");
      }
      plan = planTodoCandidate(state, candidate, options);
    } catch (error) {
      const safeError = error instanceof SyntaxError
        ? new TodoError("candidate", "不是合法 JSON")
        : error;
      const status = rejectedStatus(
        filenameCandidateId,
        Array.isArray(candidate?.operations) ? candidate.operations.length : 0,
        state,
        safeError,
        processedAt,
      );
      await commitStages([await stageJson(submissionPath, status)]);
      return status;
    }

    const status = {
      schemaVersion: 1,
      candidateId: candidate.candidateId,
      result: plan.result,
      baseRevision: candidate.baseRevision,
      revision: plan.state.revision,
      operationCount: candidate.operations.length,
      operations: plan.operationResults,
      warnings: [],
      pageUrl: "/todo/",
      processedAt,
    };
    const stages = [await stageJson(submissionPath, status)];
    if (plan.result === "published") stages.unshift(await stageJson(statePath, plan.state));
    await commitStages(stages);
    return status;
  } finally {
    await releaseLock();
  }
}
