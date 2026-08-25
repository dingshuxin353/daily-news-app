import { randomBytes } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { createTodoApplicationService } from "./application/todo-service.js";
import { planTodoCandidate } from "./domain/todo.js";
import { createFileTodoStorage } from "./storage/file-todo.js";
import {
  loadTodoConfig,
  TodoError,
  validateTodoCandidate,
  validateTodoState,
} from "./todo-validation.js";

const candidateFilenamePattern = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;

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

export { planTodoCandidate };

export async function processTodoCandidate(rootDir, candidatePath, options = {}) {
  const { dataDir, statePath } = await ensureTodoData(rootDir);
  const resolvedCandidate = await realpath(path.resolve(candidatePath));
  const candidateDir = await realpath(path.join(dataDir, "candidates"));
  if (path.dirname(resolvedCandidate) !== candidateDir) {
    throw new TodoError("candidate", "必须位于 todo/data/candidates/ 目录");
  }
  const filenameCandidateId = candidateFilenamePattern.exec(path.basename(resolvedCandidate))?.[1];
  if (!filenameCandidateId) throw new TodoError("candidate", "文件名必须是 <candidate-id>.json");

  let candidate = null;
  let candidateError = null;
  try {
    candidate = JSON.parse(await readFile(resolvedCandidate, "utf8"));
  } catch (error) {
    candidateError = error instanceof SyntaxError
      ? new TodoError("candidate", "不是合法 JSON")
      : error;
  }

  const storage = createFileTodoStorage({
    dataDir,
    statePath,
    readState: () => readTodoState(rootDir),
  });
  return createTodoApplicationService(storage, {
    validateCandidate: validateTodoCandidate,
    validateState: validateTodoState,
    generateId: options.generateId ?? (() => `todo-${randomBytes(4).toString("hex")}`),
    normalizeNow: nowValue,
  }).submit({
    candidateId: filenameCandidateId,
    candidate,
    candidateError,
    now: options.now,
  });
}
