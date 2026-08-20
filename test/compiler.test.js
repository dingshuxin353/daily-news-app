import assert from "node:assert/strict";
import test from "node:test";
import {
  CompilationError,
  compileIssue,
  compileRows,
  formatWarning,
  normalizePriorities,
  validateCompiled,
} from "../scripts/lib/compiler.js";

function item(id, priority, overrides = {}) {
  return {
    id,
    title: `标题 ${id}`,
    brief: `短摘要 ${id}`,
    summary: `完整摘要 ${id} ${"内容".repeat(60)}`,
    editorial: { priority, selectionReason: `选择理由 ${id}` },
    sources: [{ name: "Demo", url: `https://example.com/${id}` }],
    ...overrides,
  };
}

function issue(priorities) {
  return {
    schemaVersion: 1,
    date: "2026-08-20",
    generatedAt: "2026-08-20T08:00:00+08:00",
    items: priorities.map((priority, index) => item(`item-${index + 1}`, priority)),
  };
}

function rowSignature(rows) {
  return rows.map((row) => row.modules.map((module) => module.size[0].toUpperCase()).join(""));
}

test("多个 lead 与超过四个 important 按源顺序确定性降级", () => {
  const source = issue(["lead", "important", "lead", "important", "lead", "important", "important"]);
  const result = normalizePriorities(source);
  assert.deepEqual(result.resolvedPriorities.map(({ resolvedPriority }) => resolvedPriority), [
    "lead", "important", "important", "important", "important", "normal", "normal",
  ]);
  assert.deepEqual(result.warnings.filter(({ type }) => type === "priority").map((warning) => [
    warning.itemId,
    warning.sourcePriority,
    warning.compiledPriority,
  ]), [
    ["item-3", "lead", "important"],
    ["item-5", "lead", "important"],
    ["item-6", "important", "normal"],
    ["item-7", "important", "normal"],
  ]);
});

test("没有 lead 或 important 的日报可以正常编译", () => {
  const source = issue(["normal", "normal"]);
  const { compiled } = compileIssue(source);
  assert.deepEqual(compiled.items.map(({ editorial }) => editorial.priority), ["normal", "normal"]);
  assert.deepEqual(compiled.layout.rows[0].modules.map(({ resolvedPriority }) => resolvedPriority), ["normal", "normal"]);
  assert.deepEqual(compiled.layout.rows.map(({ usedCapacity }) => usedCapacity), [2]);
});

test("编译器覆盖 L、MM、MSS、SSSS 和未填满行", () => {
  const cases = [
    { priorities: ["lead"], signature: ["L"], capacities: [4] },
    { priorities: ["important", "important"], signature: ["MM"], capacities: [4] },
    { priorities: ["important", "normal", "normal"], signature: ["MSS"], capacities: [4] },
    { priorities: ["normal", "normal", "normal", "normal"], signature: ["SSSS"], capacities: [4] },
    { priorities: ["important", "normal"], signature: ["MS"], capacities: [3] },
  ];

  for (const entry of cases) {
    const resolved = normalizePriorities(issue(entry.priorities)).resolvedPriorities;
    const { rows } = compileRows(resolved, "2026-08-20");
    assert.deepEqual(rowSignature(rows), entry.signature);
    assert.deepEqual(rows.map(({ usedCapacity }) => usedCapacity), entry.capacities);
  }
});

test("换行保持输入顺序并警告未填满的中间行", () => {
  const resolved = normalizePriorities(issue(["normal", "lead", "normal"])).resolvedPriorities;
  const { rows, warnings } = compileRows(resolved, "2026-08-20");
  assert.deepEqual(rows.flatMap((row) => row.modules.map(({ itemId }) => itemId)), ["item-1", "item-2", "item-3"]);
  assert.deepEqual(rows.map(({ usedCapacity }) => usedCapacity), [1, 4, 1]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].usedCapacity, 1);
});

test("历史 image 字段产生警告且不进入编译产物", () => {
  const source = issue(["lead"]);
  source.items[0].image = "/legacy.svg";
  const { compiled, warnings } = compileIssue(source);
  assert.equal("image" in compiled.items[0], false);
  assert.equal(warnings.some(({ type }) => type === "image"), true);
});

test("标题、brief 和 summary 超出建议长度时只产生警告", () => {
  const source = issue(["normal"]);
  source.items[0].title = "长".repeat(29);
  source.items[0].brief = "长".repeat(81);
  source.items[0].summary = "长".repeat(401);
  const { compiled, warnings } = compileIssue(source);
  assert.equal(compiled.items.length, 1);
  assert.equal(warnings.filter(({ type }) => type === "length").length, 2);
  assert.equal(warnings.filter(({ type }) => type === "length-range").length, 1);
});

test("编译产物保留 editorial 与多个来源，并只生成一个布局模块", () => {
  const source = issue(["lead"]);
  source.items[0].sources.push({ name: "Supplement", url: "https://example.com/supplement" });
  const { compiled } = compileIssue(source);
  assert.deepEqual(compiled.items[0].editorial, source.items[0].editorial);
  assert.deepEqual(compiled.items[0].sources, source.items[0].sources);
  assert.equal(compiled.layout.rows[0].modules.length, 1);
  assert.equal(compiled.layout.rows[0].modules[0].resolvedPriority, "lead");
});

test("编译产物缺失、重复内容或超载时校验失败", () => {
  const source = issue(["normal", "normal"]);
  const { compiled } = compileIssue(source);
  compiled.layout.rows[0].modules.push({ itemId: "item-1", resolvedPriority: "normal", size: "small", span: 1 });
  compiled.layout.rows[0].usedCapacity = 3;
  assert.throws(() => validateCompiled(source, compiled, "fixture.json"), CompilationError);

  const overloaded = compileIssue(source).compiled;
  overloaded.layout.rows[0].usedCapacity = 5;
  assert.throws(() => validateCompiled(source, overloaded, "fixture.json"), /范围为 1–4/);

  const missingItem = compileIssue(source).compiled;
  missingItem.items.pop();
  assert.throws(() => validateCompiled(source, missingItem, "fixture.json"), /内容 ID 缺失/);

  const wrongSize = compileIssue(source).compiled;
  wrongSize.layout.rows[0].modules[0].size = "medium";
  wrongSize.layout.rows[0].modules[0].span = 2;
  wrongSize.layout.rows[0].usedCapacity = 3;
  assert.throws(() => validateCompiled(source, wrongSize, "fixture.json"), /size 与 span 映射无效/);

  const changedEditorial = compileIssue(source).compiled;
  changedEditorial.items[0].editorial.priority = "lead";
  assert.throws(() => validateCompiled(source, changedEditorial, "fixture.json"), /editorial 或 sources/);
});

test("降级警告包含日期、内容 ID、源优先级、编译优先级和原因", () => {
  const source = issue(["lead", "lead"]);
  const warning = normalizePriorities(source).warnings.find(({ type }) => type === "priority");
  const output = formatWarning(warning);
  assert.match(output, /2026-08-20/);
  assert.match(output, /item-2/);
  assert.match(output, /lead → important/);
  assert.match(output, /大模块上限为 1/);
});

test("Demo 数据覆盖 L、MM、MSS、SSSS 和未满末行", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const signatures = [];
  const capacities = [];
  for (const date of ["2026-08-19", "2026-08-18"]) {
    const source = JSON.parse(await readFile(path.join(root, "data", "issues", `${date}.json`), "utf8"));
    const { compiled } = compileIssue(source);
    signatures.push(...rowSignature(compiled.layout.rows));
    capacities.push(...compiled.layout.rows.map(({ usedCapacity }) => usedCapacity));
  }
  assert.deepEqual(signatures, ["L", "MM", "MSS", "SSSS", "S"]);
  assert.deepEqual(capacities, [4, 4, 4, 4, 1]);
});
