import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  TodoError,
  validateTodoCandidate,
  validateTodoConfig,
  validateTodoState,
} from "./domain/todo-validation.js";

export {
  TodoError,
  validateTodoCandidate,
  validateTodoConfig,
  validateTodoState,
};

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
