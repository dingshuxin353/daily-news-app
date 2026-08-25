import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDailyApplicationService } from "../scripts/lib/application/daily-service.js";
import { createThemeApplicationService } from "../scripts/lib/application/theme-service.js";
import { createTodoApplicationService } from "../scripts/lib/application/todo-service.js";
import { validateCandidateValue } from "../scripts/lib/domain/content-validation.js";
import { planTodoCandidate } from "../scripts/lib/domain/todo.js";
import { validateTodoCandidate, validateTodoState } from "../scripts/lib/domain/todo-validation.js";
import { buildTodoProjection as buildDomainTodoProjection } from "../scripts/lib/domain/todo-projection.js";
import { resolveThemeCandidateValue } from "../scripts/lib/domain/theme-validation.js";
import {
  createOverrideThemeConfig,
  nextThemeRevision,
  resolveThemeSelection,
} from "../scripts/lib/domain/theme-state.js";
import {
  compileThemeCss,
  createThemeDefinition,
  createThemeManifest,
} from "../scripts/lib/theme-compiler.js";
import { requireDailyStorage, requireThemeStorage } from "../scripts/lib/storage/ports.js";
import { createTestIssue } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function candidateFromIssue(issue) {
  const candidate = structuredClone(issue);
  delete candidate.revision;
  return candidate;
}

function createMemoryDailyStorage(initial = {}) {
  const state = {
    issue: structuredClone(initial.issue ?? null),
    compiled: structuredClone(initial.compiled ?? null),
    index: structuredClone(initial.index ?? null),
    dates: structuredClone(initial.dates ?? []),
    commits: 0,
  };
  return {
    state,
    async withWriteTransaction(_date, work) {
      return work({
        readIssue: async () => structuredClone(state.issue),
        readCompiled: async () => structuredClone(state.compiled),
        readIndex: async () => structuredClone(state.index),
        listIssueDates: async () => structuredClone(state.dates),
        async commit(changes) {
          for (const key of ["issue", "compiled", "index"]) {
            if (changes[key] !== undefined) state[key] = structuredClone(changes[key]);
          }
          state.dates = structuredClone(state.index?.dates ?? state.dates);
          state.commits += 1;
        },
      });
    },
  };
}

function createMemoryThemeStorage(initial) {
  const state = {
    previews: new Map(),
    revisions: new Map(initial.revisions),
    selection: structuredClone(initial.selection),
    homeActiveTheme: structuredClone(initial.homeActiveTheme),
    active: structuredClone(initial.active),
    commits: 0,
  };
  const readThemeRevision = async (themeId, revision) => (
    structuredClone(state.revisions.get(`${themeId}@${revision}`) ?? null)
  );
  const listRevisions = async (themeId) => [...state.revisions.keys()]
    .filter((key) => key.startsWith(`${themeId}@`))
    .map((key) => Number(key.split("@").at(-1)))
    .sort((left, right) => left - right);
  const reads = {
    readPreview: async (themeId) => structuredClone(state.previews.get(themeId) ?? null),
    listThemeIds: async () => [...new Set([...state.revisions.keys()].map((key) => key.split("@")[0]))].sort(),
    listRevisions,
    readThemeRevision,
    readSelection: async () => structuredClone(state.selection),
    readHomeActiveTheme: async () => structuredClone(state.homeActiveTheme),
    readActive: async () => structuredClone(state.active),
  };
  async function commit(changes) {
    if (changes.revision) {
      state.revisions.set(
        `${changes.revision.themeId}@${changes.revision.revision}`,
        structuredClone({ definition: changes.revision.definition, css: changes.revision.css }),
      );
    }
    if (changes.selection) state.selection = structuredClone(changes.selection);
    if (changes.active) state.active = structuredClone(changes.active);
    state.commits += 1;
  }
  return {
    state,
    ...reads,
    async writePreview(themeId, preview) {
      state.previews.set(themeId, structuredClone(preview));
      state.commits += 1;
    },
    async withWriteTransaction(work) {
      return work({ ...reads, commit });
    },
  };
}

test("Daily Application Service 在内存适配器与文件适配器之间共享同一事务端口", async () => {
  const candidate = candidateFromIssue(createTestIssue("2026-08-24"));
  const storage = createMemoryDailyStorage();
  const service = createDailyApplicationService(storage);

  const created = await service.submit({
    candidate,
    publicationId: "daily-news",
    priorityLimits: { lead: 1, important: 2, normal: null },
  });
  assert.equal(created.result, "created");
  assert.equal(created.revision, 1);
  assert.equal(storage.state.issue.revision, 1);
  assert.equal(storage.state.compiled.revision, 1);
  assert.deepEqual(storage.state.index, { latest: "2026-08-24", dates: ["2026-08-24"] });
  assert.equal(storage.state.commits, 1);

  const repeated = await service.submit({
    candidate,
    publicationId: "daily-news",
    priorityLimits: { lead: 1, important: 2, normal: null },
  });
  assert.equal(repeated.result, "unchanged");
  assert.equal(repeated.revision, 1);
  assert.deepEqual(repeated.repaired, []);
  assert.equal(storage.state.commits, 1);
});

test("Content Validator 对内存 Candidate 复用同一规则并注入资源边界", async () => {
  const candidate = candidateFromIssue(createTestIssue("2026-08-24"));
  candidate.schemaVersion = 2;
  candidate.items[0].image = {
    src: "/checked-image.svg",
    alt: "内存候选测试图",
    width: 1200,
    height: 800,
    credit: "测试",
  };
  const checked = [];
  const result = await validateCandidateValue(candidate, {
    filePath: "memory-candidate",
    expectedDate: "2026-08-24",
    validateAsset: async (value) => checked.push(value),
  });
  assert.equal(result, candidate);
  assert.deepEqual(checked, ["/checked-image.svg"]);
});

test("Daily Storage 缺少事务方法时在进入领域写入前失败", () => {
  assert.throws(() => requireDailyStorage({}), /withWriteTransaction/);
  assert.throws(() => createDailyApplicationService(null), /DailyStorage/);
});

test("Theme Storage 缺少语义方法时在应用服务启动前失败", () => {
  assert.throws(() => requireThemeStorage({}), /readPreview/);
  assert.throws(() => createThemeApplicationService({}), /ThemeStorage\.readPreview/);
});

test("Todo Writer 使用宿主注入的 ID、时间和状态校验得到确定结果", () => {
  const state = { schemaVersion: 1, revision: 0, updatedAt: null, items: [] };
  const candidate = {
    schemaVersion: 1,
    candidateId: "domain-test",
    generatedAt: "2026-08-24T08:00:00+08:00",
    baseRevision: 0,
    operations: [{ type: "add", clientId: "first", title: "领域测试" }],
  };
  const plan = planTodoCandidate(state, candidate, {
    now: "2026-08-24T08:01:00+08:00",
    generateId: () => "todo-1234abcd",
    validateState: validateTodoState,
  });
  assert.equal(plan.result, "published");
  assert.equal(plan.state.revision, 1);
  assert.equal(plan.state.items[0].id, "todo-1234abcd");
  assert.equal(state.revision, 0);
  assert.deepEqual(state.items, []);
});

test("Todo Projection 只使用宿主提供的业务日期", () => {
  const state = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2026-08-24T08:00:00+08:00",
    items: [{
      id: "todo-1234abcd",
      title: "领域投影测试",
      dueDate: "2026-08-24",
      status: "open",
      createdAt: "2026-08-24T08:00:00+08:00",
      updatedAt: "2026-08-24T08:00:00+08:00",
      completedAt: null,
      archivedAt: null,
    }],
  };
  assert.throws(() => buildDomainTodoProjection(state), /宿主提供/);
  const projection = buildDomainTodoProjection(state, { asOfDate: "2026-08-24" });
  assert.equal(projection.groups.today.length, 1);
  assert.equal(projection.sourceRevision, 1);
});

test("Todo Application Service 通过同一事务端口提交 State 与 Submission", async () => {
  const storageState = {
    state: { schemaVersion: 1, revision: 0, updatedAt: null, items: [] },
    submissions: new Map(),
    commits: 0,
  };
  const storage = {
    async withWriteTransaction(candidateId, work) {
      return work({
        readSubmission: async () => structuredClone(storageState.submissions.get(candidateId) ?? null),
        readState: async () => structuredClone(storageState.state),
        async commit(changes) {
          if (changes.state) storageState.state = structuredClone(changes.state);
          if (changes.submission) {
            storageState.submissions.set(candidateId, structuredClone(changes.submission));
          }
          storageState.commits += 1;
        },
      });
    },
  };
  const service = createTodoApplicationService(storage, {
    validateCandidate: validateTodoCandidate,
    validateState: validateTodoState,
    generateId: () => "todo-89abcdef",
    normalizeNow: (value) => value,
  });
  const candidate = {
    schemaVersion: 1,
    candidateId: "todo-port-test",
    generatedAt: "2026-08-24T08:00:00+08:00",
    baseRevision: 0,
    operations: [{ type: "add", clientId: "first", title: "事务端口测试" }],
  };
  const result = await service.submit({
    candidateId: candidate.candidateId,
    candidate,
    now: "2026-08-24T08:02:00+08:00",
  });
  assert.equal(result.result, "published");
  assert.equal(storageState.state.revision, 1);
  assert.equal(storageState.submissions.get(candidate.candidateId).revision, 1);
  assert.equal(storageState.commits, 1);

  const repeated = await service.submit({
    candidateId: candidate.candidateId,
    candidate,
    now: "invalid-but-idempotent-retry-does-not-reprocess",
  });
  assert.deepEqual(repeated, result);
  assert.equal(storageState.commits, 1);
});

test("Theme Validator 与 Resolver 对内存 Candidate 复用同一规则", async () => {
  const preset = JSON.parse(await readFile(path.join(rootDir, "themes", "presets", "newspaper-default.json"), "utf8"));
  const candidate = {
    schemaVersion: 1,
    id: "memory-theme",
    name: "内存主题",
    extends: "newspaper-default",
    tokens: { colors: { accent: "#A23B2A" } },
    recipes: {},
  };
  const result = await resolveThemeCandidateValue(candidate, {
    source: "memory-theme",
    loadPreset: async (id) => {
      assert.equal(id, "newspaper-default");
      return preset;
    },
  });
  assert.equal(result.resolved.id, "memory-theme");
  assert.equal(result.resolved.tokens.colors.accent, "#A23B2A");
});

test("Theme revision 与 selection 规则不依赖存储位置", () => {
  assert.equal(nextThemeRevision([]), 1);
  assert.equal(nextThemeRevision([1, 3, 2]), 4);
  const config = createOverrideThemeConfig("newspaper-default", 2);
  assert.deepEqual(resolveThemeSelection(config), {
    config,
    activeTheme: { id: "newspaper-default", revision: 2 },
    inherited: false,
    legacy: false,
  });
  assert.deepEqual(
    resolveThemeSelection(
      { schemaVersion: 2, mode: "inherit" },
      { homeActiveTheme: { id: "midnight-tech", revision: 1 } },
    ).activeTheme,
    { id: "midnight-tech", revision: 1 },
  );
});

test("Theme Application Service 通过内存存储端口完成预览与激活", async () => {
  const preset = JSON.parse(await readFile(path.join(rootDir, "themes", "presets", "newspaper-default.json"), "utf8"));
  const baseDefinition = createThemeDefinition(preset, 1, { usesSiteAccent: true });
  const storage = createMemoryThemeStorage({
    revisions: [["newspaper-default@1", {
      definition: baseDefinition,
      css: compileThemeCss(preset, 1, { usesSiteAccent: true }),
    }]],
    selection: createOverrideThemeConfig("newspaper-default", 1),
    homeActiveTheme: { id: "newspaper-default", revision: 1 },
    active: createThemeManifest(
      baseDefinition,
      "/themes/compiled/newspaper-default/1.css",
      null,
    ),
  });
  const service = createThemeApplicationService(storage);
  const candidate = {
    schemaVersion: 1,
    id: "memory-theme",
    name: "内存主题",
    extends: "newspaper-default",
    tokens: { colors: { accent: "#A23B2A" } },
    recipes: {},
  };
  const resolved = {
    ...structuredClone(preset),
    id: candidate.id,
    name: candidate.name,
    extends: candidate.extends,
    tokens: {
      ...structuredClone(preset.tokens),
      colors: { ...structuredClone(preset.tokens.colors), accent: "#A23B2A" },
    },
  };
  assert.equal((await service.preview({ candidate, resolved, usesSiteAccent: false })).result, "preview-ready");
  const activated = await service.activate({ candidate, resolved, usesSiteAccent: false });
  assert.deepEqual(
    { result: activated.result, themeId: activated.themeId, revision: activated.revision },
    { result: "activated", themeId: "memory-theme", revision: 1 },
  );
  assert.deepEqual(storage.state.selection.activeTheme, { id: "memory-theme", revision: 1 });
  assert.equal(storage.state.active.themeId, "memory-theme");
  assert.ok(storage.state.revisions.has("memory-theme@1"));
  await assert.rejects(() => service.switch({ themeId: "../outside" }), /themeId/);
});

test("领域核心不导入路径、文件系统、HTTP、数据库或环境变量", async () => {
  const coreFiles = [
    ["domain", "value.js"],
    ["domain", "content-validation.js"],
    ["domain", "daily.js"],
    ["domain", "todo.js"],
    ["domain", "todo-validation.js"],
    ["domain", "todo-projection.js"],
    ["domain", "theme.js"],
    ["domain", "theme-validation.js"],
    ["domain", "theme-state.js"],
    ["application", "daily-service.js"],
    ["application", "theme-service.js"],
    ["application", "todo-service.js"],
  ];
  for (const segments of coreFiles) {
    const source = await readFile(path.join(rootDir, "scripts", "lib", ...segments), "utf8");
    const name = segments.join("/");
    assert.doesNotMatch(source, /node:(?:fs|path|http|https)|process\.env|postgres|pg\b/i, name);
  }
});
