const MODULES = {
  lead: { size: "large", span: 4 },
  important: { size: "medium", span: 2 },
  normal: { size: "small", span: 1 },
};

const LENGTH_LIMITS = {
  lead: { title: 42, summary: 160 },
  important: { title: 36, summary: 100 },
  normal: { title: 28, summary: 60 },
};

export class CompilationError extends Error {
  constructor(filePath, field, message) {
    super(`${filePath}: ${field} ${message}`);
    this.name = "CompilationError";
  }
}

function textLength(value) {
  return [...value].length;
}

function copyCompiledItem(item, priority) {
  const compiled = {
    id: item.id,
    title: item.title,
    summary: item.summary,
    priority,
    source: { ...item.source },
  };
  if (item.category !== undefined) compiled.category = item.category;
  return compiled;
}

export function normalizePriorities(issue) {
  let hasLead = false;
  let importantCount = 0;
  const warnings = [];
  const items = issue.items.map((item) => {
    const sourcePriority = item.priority;
    let priority = sourcePriority;

    if (sourcePriority === "lead") {
      if (!hasLead) {
        hasLead = true;
      } else if (importantCount < 4) {
        priority = "important";
        importantCount += 1;
        warnings.push({
          type: "priority",
          date: issue.date,
          itemId: item.id,
          sourcePriority,
          compiledPriority: priority,
          reason: "大模块上限为 1，降为中模块",
        });
      } else {
        priority = "normal";
        warnings.push({
          type: "priority",
          date: issue.date,
          itemId: item.id,
          sourcePriority,
          compiledPriority: priority,
          reason: "大模块和中模块均已达到数量上限",
        });
      }
    } else if (sourcePriority === "important") {
      if (importantCount < 4) {
        importantCount += 1;
      } else {
        priority = "normal";
        warnings.push({
          type: "priority",
          date: issue.date,
          itemId: item.id,
          sourcePriority,
          compiledPriority: priority,
          reason: "中模块上限为 4，降为小模块",
        });
      }
    }

    const limits = LENGTH_LIMITS[sourcePriority];
    for (const field of ["title", "summary"]) {
      const length = textLength(item[field]);
      if (length > limits[field]) {
        warnings.push({
          type: "length",
          date: issue.date,
          itemId: item.id,
          field,
          length,
          limit: limits[field],
          priority: sourcePriority,
        });
      }
    }
    if (item.image !== undefined) {
      warnings.push({ type: "image", date: issue.date, itemId: item.id });
    }

    return copyCompiledItem(item, priority);
  });
  return { items, warnings };
}

export function compileRows(items, date = "unknown") {
  const rows = [];
  const warnings = [];
  let current = { usedCapacity: 0, modules: [] };

  for (const item of items) {
    const module = MODULES[item.priority];
    if (!module) throw new CompilationError(date, `items.${item.id}.priority`, "没有对应模块尺寸");

    if (current.usedCapacity + module.span > 4) {
      if (current.usedCapacity < 4) {
        warnings.push({
          type: "layout",
          date,
          usedCapacity: current.usedCapacity,
          nextItemId: item.id,
          reason: "下一个模块无法放入当前行，非最后一行保留空余容量",
        });
      }
      rows.push(current);
      current = { usedCapacity: 0, modules: [] };
    }

    current.modules.push({ itemId: item.id, size: module.size, span: module.span });
    current.usedCapacity += module.span;
  }

  if (current.modules.length > 0) rows.push(current);
  return { rows, warnings };
}

export function validateCompiled(sourceIssue, compiled, filePath = sourceIssue.date) {
  const expectedIds = sourceIssue.items.map((item) => item.id);
  const compiledIds = compiled.items.map((item) => item.id);
  if (
    compiledIds.length !== new Set(compiledIds).size
    || compiledIds.length !== expectedIds.length
    || expectedIds.some((id, index) => compiledIds[index] !== id)
  ) {
    throw new CompilationError(filePath, "items", "内容 ID 缺失、重复或顺序与源数据不一致");
  }

  const compiledItems = new Map(compiled.items.map((item) => [item.id, item]));
  const layoutIds = [];

  for (const [rowIndex, row] of compiled.layout.rows.entries()) {
    const sum = row.modules.reduce((total, module) => total + module.span, 0);
    if (row.usedCapacity !== sum || sum < 1 || sum > 4) {
      throw new CompilationError(filePath, `layout.rows[${rowIndex}].usedCapacity`, "必须等于模块 span 之和且范围为 1–4");
    }
    for (const module of row.modules) {
      const item = compiledItems.get(module.itemId);
      const expected = item ? MODULES[item.priority] : undefined;
      if (!expected || expected.size !== module.size || expected.span !== module.span) {
        throw new CompilationError(filePath, `layout.rows[${rowIndex}].modules.${module.itemId}`, "size 与 span 映射无效");
      }
      layoutIds.push(module.itemId);
    }
  }

  if (layoutIds.length !== new Set(layoutIds).size) {
    throw new CompilationError(filePath, "layout.rows", "存在重复的内容 ID");
  }
  if (layoutIds.length !== expectedIds.length || expectedIds.some((id, index) => layoutIds[index] !== id)) {
    throw new CompilationError(filePath, "layout.rows", "内容 ID 缺失或顺序与源数据不一致");
  }
}

export function compileIssue(issue, filePath = issue.date) {
  const normalized = normalizePriorities(issue);
  const layout = compileRows(normalized.items, issue.date);
  const compiled = {
    date: issue.date,
    generatedAt: issue.generatedAt,
    items: normalized.items,
    layout: { rows: layout.rows },
  };
  validateCompiled(issue, compiled, filePath);
  return { compiled, warnings: [...normalized.warnings, ...layout.warnings] };
}

export function formatWarning(warning) {
  if (warning.type === "priority") {
    return `[警告] ${warning.date} 内容 ${warning.itemId}: ${warning.sourcePriority} → ${warning.compiledPriority}；${warning.reason}`;
  }
  if (warning.type === "length") {
    return `[警告] ${warning.date} 内容 ${warning.itemId}: ${warning.priority} 的 ${warning.field} 长度 ${warning.length}，建议不超过 ${warning.limit}`;
  }
  if (warning.type === "image") {
    return `[警告] ${warning.date} 内容 ${warning.itemId}: image 字段已忽略`;
  }
  return `[警告] ${warning.date} 行容量 ${warning.usedCapacity}/4，下一个内容 ${warning.nextItemId}；${warning.reason}`;
}
