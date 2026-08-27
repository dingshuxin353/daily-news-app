import { validateCompiled } from "../compiler.js";

/**
 * @param {any} compiled
 * @param {any} [sourceIssue]
 */
export function buildDailyReadingProjection(compiled, sourceIssue) {
  if (sourceIssue) {
    validateCompiled(sourceIssue, compiled, `Compiled Edition ${compiled?.date ?? "unknown"}`);
  }
  if (!compiled || !Array.isArray(compiled.items)) {
    throw new Error("Compiled Edition 缺少稳定阅读结构");
  }
  const items = new Map(compiled.items.map((item) => [item.id, item]));
  const sourceRows = Array.isArray(compiled.layout?.rows)
    ? compiled.layout.rows
    : [{
        usedCapacity: compiled.items.length,
        modules: compiled.items.map((item) => ({
          itemId: item.id,
          resolvedPriority: item.editorial?.priority ?? "normal",
          size: "small",
          span: 1,
          item,
        })),
      }];
  return {
    schemaVersion: 1,
    date: compiled.date,
    rows: sourceRows.map((row) => ({
      usedCapacity: row.usedCapacity,
      modules: row.modules.map((module) => ({
        ...structuredClone(module),
        item: structuredClone(module.item ?? items.get(module.itemId)),
      })),
    })),
  };
}
