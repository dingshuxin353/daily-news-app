export const DAILY_WRITE_TRANSACTION_METHODS = Object.freeze([
  "readIssue",
  "readCompiled",
  "readIndex",
  "listIssueDates",
  "commit",
]);

export const TODO_WRITE_TRANSACTION_METHODS = Object.freeze([
  "readSubmission",
  "readState",
  "commit",
]);

export const THEME_STORAGE_METHODS = Object.freeze([
  "readPreview",
  "writePreview",
  "listThemeIds",
  "listRevisions",
  "readThemeRevision",
  "readSelection",
  "readHomeActiveTheme",
  "readActive",
  "withWriteTransaction",
]);

export const THEME_WRITE_TRANSACTION_METHODS = Object.freeze([
  "listRevisions",
  "readThemeRevision",
  "readSelection",
  "readHomeActiveTheme",
  "readActive",
  "commit",
]);

function requireMethods(value, methods, name) {
  if (!value || typeof value !== "object") throw new TypeError(`${name} 必须是对象`);
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      throw new TypeError(`${name}.${method} 必须是函数`);
    }
  }
  return value;
}

export function requireDailyStorage(storage) {
  return requireMethods(storage, ["withWriteTransaction"], "DailyStorage");
}

export function requireDailyWriteTransaction(transaction) {
  return requireMethods(transaction, DAILY_WRITE_TRANSACTION_METHODS, "DailyWriteTransaction");
}

export function requireTodoStorage(storage) {
  return requireMethods(storage, ["withWriteTransaction"], "TodoStorage");
}

export function requireTodoWriteTransaction(transaction) {
  return requireMethods(transaction, TODO_WRITE_TRANSACTION_METHODS, "TodoWriteTransaction");
}

export function requireThemeStorage(storage) {
  return requireMethods(storage, THEME_STORAGE_METHODS, "ThemeStorage");
}

export function requireThemeWriteTransaction(transaction) {
  return requireMethods(transaction, THEME_WRITE_TRANSACTION_METHODS, "ThemeWriteTransaction");
}
