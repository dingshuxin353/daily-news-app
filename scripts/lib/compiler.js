const MODULES = {
  lead: { size: "large", span: 4 },
  important: { size: "medium", span: 2 },
  normal: { size: "small", span: 1 },
};

const LENGTH_LIMITS = {
  lead: { title: 42 },
  important: { title: 36 },
  normal: { title: 28 },
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

function copyCompiledItem(item) {
  const compiled = {
    id: item.id,
    title: item.title,
    brief: item.brief,
    summary: item.summary,
    editorial: { ...item.editorial },
    sources: item.sources.map((source) => ({
      ...source,
      ...(source.via ? { via: { ...source.via } } : {}),
    })),
  };
  if (item.category !== undefined) compiled.category = item.category;
  return compiled;
}

export function normalizePriorities(issue) {
  let hasLead = false;
  let importantCount = 0;
  const warnings = [];
  const resolvedPriorities = issue.items.map((item) => {
    const sourcePriority = item.editorial.priority;
    let resolvedPriority = sourcePriority;

    if (sourcePriority === "lead") {
      if (!hasLead) {
        hasLead = true;
      } else if (importantCount < 4) {
        resolvedPriority = "important";
        importantCount += 1;
        warnings.push({
          type: "priority",
          date: issue.date,
          itemId: item.id,
          sourcePriority,
          compiledPriority: resolvedPriority,
          reason: "大模块上限为 1，降为中模块",
        });
      } else {
        resolvedPriority = "normal";
        warnings.push({
          type: "priority",
          date: issue.date,
          itemId: item.id,
          sourcePriority,
          compiledPriority: resolvedPriority,
          reason: "大模块和中模块均已达到数量上限",
        });
      }
    } else if (sourcePriority === "important") {
      if (importantCount < 4) {
        importantCount += 1;
      } else {
        resolvedPriority = "normal";
        warnings.push({
          type: "priority",
          date: issue.date,
          itemId: item.id,
          sourcePriority,
          compiledPriority: resolvedPriority,
          reason: "中模块上限为 4，降为小模块",
        });
      }
    }

    const titleLength = textLength(item.title);
    if (titleLength > LENGTH_LIMITS[sourcePriority].title) {
      warnings.push({
        type: "length",
        date: issue.date,
        itemId: item.id,
        field: "title",
        length: titleLength,
        limit: LENGTH_LIMITS[sourcePriority].title,
        priority: sourcePriority,
      });
    }
    const briefLength = textLength(item.brief);
    if (briefLength > 80) {
      warnings.push({ type: "length", date: issue.date, itemId: item.id, field: "brief", length: briefLength, limit: 80 });
    }
    const summaryLength = textLength(item.summary);
    if (summaryLength < 120 || summaryLength > 400) {
      warnings.push({ type: "length-range", date: issue.date, itemId: item.id, field: "summary", length: summaryLength, min: 120, max: 400 });
    }
    const reasonLength = textLength(item.editorial.selectionReason);
    if (reasonLength > 120) {
      warnings.push({ type: "length", date: issue.date, itemId: item.id, field: "editorial.selectionReason", length: reasonLength, limit: 120 });
    }
    if (item.image !== undefined) {
      warnings.push({ type: "image", date: issue.date, itemId: item.id });
    }

    return { itemId: item.id, resolvedPriority };
  });
  return { resolvedPriorities, warnings };
}

export function compileRows(resolvedPriorities, date = "unknown") {
  const rows = [];
  const warnings = [];
  let current = { usedCapacity: 0, modules: [] };

  for (const item of resolvedPriorities) {
    const module = MODULES[item.resolvedPriority];
    if (!module) throw new CompilationError(date, `items.${item.itemId}.resolvedPriority`, "没有对应模块尺寸");

    if (current.usedCapacity + module.span > 4) {
      if (current.usedCapacity < 4) {
        warnings.push({
          type: "layout",
          date,
          usedCapacity: current.usedCapacity,
          nextItemId: item.itemId,
          reason: "下一个模块无法放入当前行，非最后一行保留空余容量",
        });
      }
      rows.push(current);
      current = { usedCapacity: 0, modules: [] };
    }

    current.modules.push({ itemId: item.itemId, resolvedPriority: item.resolvedPriority, size: module.size, span: module.span });
    current.usedCapacity += module.span;
  }

  if (current.modules.length > 0) rows.push(current);
  return { rows, warnings };
}

export function validateCompiled(sourceIssue, compiled, filePath = sourceIssue.date) {
  if (compiled.schemaVersion !== 1) {
    throw new CompilationError(filePath, "schemaVersion", "必须等于 1");
  }
  if (
    compiled.date !== sourceIssue.date
    || compiled.generatedAt !== sourceIssue.generatedAt
    || compiled.revision !== sourceIssue.revision
    || JSON.stringify(compiled.coverage) !== JSON.stringify(sourceIssue.coverage)
  ) {
    throw new CompilationError(filePath, "date/generatedAt/revision/coverage", "必须与正式日报一致");
  }
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
      const expected = MODULES[module.resolvedPriority];
      if (!item || !expected || expected.size !== module.size || expected.span !== module.span) {
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

  for (const sourceItem of sourceIssue.items) {
    const item = compiledItems.get(sourceItem.id);
    if (JSON.stringify(item) !== JSON.stringify(copyCompiledItem(sourceItem))) {
      throw new CompilationError(filePath, `items.${sourceItem.id}`, "内容与正式日报不一致");
    }
  }
}

export function compileIssue(issue, filePath = issue.date) {
  const normalized = normalizePriorities(issue);
  const layout = compileRows(normalized.resolvedPriorities, issue.date);
  const compiled = {
    schemaVersion: issue.schemaVersion,
    date: issue.date,
    generatedAt: issue.generatedAt,
    coverage: { ...issue.coverage },
    revision: issue.revision,
    items: issue.items.map(copyCompiledItem),
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
    const priority = warning.priority ? `${warning.priority} 的 ` : "";
    return `[警告] ${warning.date} 内容 ${warning.itemId}: ${priority}${warning.field} 长度 ${warning.length}，建议不超过 ${warning.limit}`;
  }
  if (warning.type === "length-range") {
    return `[警告] ${warning.date} 内容 ${warning.itemId}: ${warning.field} 长度 ${warning.length}，建议保持在 ${warning.min}–${warning.max}`;
  }
  if (warning.type === "image") {
    return `[警告] ${warning.date} 内容 ${warning.itemId}: image 字段已忽略`;
  }
  return `[警告] ${warning.date} 行容量 ${warning.usedCapacity}/4，下一个内容 ${warning.nextItemId}；${warning.reason}`;
}
