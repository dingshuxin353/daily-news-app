import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  ensureTodoData,
  processTodoCandidate,
  readTodoState,
} from "../scripts/lib/todo-pipeline.js";
import { startTodoHost, todoLogRecord } from "../scripts/lib/todo-host.js";
import {
  validateTodoCandidate,
  validateTodoConfig,
  validateTodoState,
} from "../scripts/lib/todo-validation.js";
import { buildTodoProjection } from "../scripts/lib/todo-view.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const now = "2026-08-23T18:30:00+08:00";

async function fixture(enabled = true) {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-todo-"));
  await mkdir(path.join(target, "config"), { recursive: true });
  await writeFile(path.join(target, "config", "todo.json"), `${JSON.stringify({
    schemaVersion: 1,
    enabled,
  }, null, 2)}\n`);
  await ensureTodoData(target);
  return target;
}

async function writeCandidate(target, candidate, source = null, filename = null) {
  const filePath = path.join(
    target,
    "todo",
    "data",
    "candidates",
    filename ?? `${candidate.candidateId}.json`,
  );
  await writeFile(filePath, source ?? `${JSON.stringify(candidate, null, 2)}\n`);
  return filePath;
}

function candidate(candidateId, baseRevision, operations) {
  return {
    schemaVersion: 1,
    candidateId,
    generatedAt: "2026-08-23T18:20:00+08:00",
    baseRevision,
    operations,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("Todo 配置严格校验，首次初始化 revision 0 空状态", async () => {
  assert.deepEqual(validateTodoConfig({ schemaVersion: 1, enabled: false }), {
    schemaVersion: 1,
    enabled: false,
  });
  assert.throws(() => validateTodoConfig({ schemaVersion: 1, enabled: false, name: "私事" }), /name.*不允许/);
  assert.throws(() => validateTodoConfig({ schemaVersion: 1, enabled: "yes" }), /enabled.*布尔值/);

  const target = await fixture(false);
  const state = await readTodoState(target);
  assert.deepEqual(state, { schemaVersion: 1, revision: 0, updatedAt: null, items: [] });
});

test("Todo Projection 按上海日期生成固定五分组和最多五条 Home 顺序", () => {
  const makeItem = (id, title, change = {}) => ({
    id,
    title,
    status: "open",
    createdAt: "2026-08-20T10:00:00+08:00",
    updatedAt: "2026-08-23T10:00:00+08:00",
    completedAt: null,
    archivedAt: null,
    ...change,
  });
  const state = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2026-08-23T18:30:00+08:00",
    items: [
      makeItem("todo-00000001", "未来", { dueDate: "2026-08-25" }),
      makeItem("todo-00000002", "今天无时间", { dueDate: "2026-08-23" }),
      makeItem("todo-00000003", "逾期较晚", { dueDate: "2026-08-22", dueTime: "18:00" }),
      makeItem("todo-00000004", "逾期较早", { dueDate: "2026-08-21" }),
      makeItem("todo-00000005", "今天有时间", { dueDate: "2026-08-23", dueTime: "09:00" }),
      makeItem("todo-00000006", "无日期"),
      makeItem("todo-00000007", "今天完成", {
        status: "completed",
        completedAt: "2026-08-23T17:00:00+08:00",
      }),
      makeItem("todo-00000008", "昨日完成", {
        status: "completed",
        completedAt: "2026-08-22T23:59:00+08:00",
      }),
      makeItem("todo-00000009", "已归档", {
        status: "archived",
        archivedAt: "2026-08-23T12:00:00+08:00",
      }),
    ],
  };
  const projection = buildTodoProjection(state, { asOfDate: "2026-08-23" });
  assert.deepEqual(projection.groups.overdue.map(({ id }) => id), ["todo-00000004", "todo-00000003"]);
  assert.deepEqual(projection.groups.today.map(({ id }) => id), ["todo-00000005", "todo-00000002"]);
  assert.deepEqual(projection.groups.upcoming.map(({ id }) => id), ["todo-00000001"]);
  assert.deepEqual(projection.groups.undated.map(({ id }) => id), ["todo-00000006"]);
  assert.deepEqual(projection.groups.completedToday.map(({ id }) => id), ["todo-00000007"]);
  assert.deepEqual(projection.homeItems.map(({ id }) => id), [
    "todo-00000004",
    "todo-00000003",
    "todo-00000005",
    "todo-00000002",
    "todo-00000001",
  ]);
  assert.equal(projection.sourceRevision, 1);
});

test("add 原子新增同名任务，由 Writer 生成不冲突 ID 并只增加一次 revision", async () => {
  const target = await fixture();
  const source = candidate("add-weekly-report", 0, [
    {
      type: "add",
      clientId: "weekly-one",
      title: "  提交本周周报  ",
      note: " 补充产品数据部分 ",
      dueDate: "2026-08-24",
      dueTime: "15:00",
    },
    { type: "add", clientId: "weekly-two", title: "提交本周周报" },
  ]);
  const candidatePath = await writeCandidate(target, source);
  const ids = ["todo-11111111", "todo-22222222"];
  const result = await processTodoCandidate(target, candidatePath, {
    now,
    generateId: () => ids.shift(),
  });
  const state = await readTodoState(target);

  assert.equal(result.result, "published");
  assert.equal(result.revision, 1);
  assert.equal(state.revision, 1);
  assert.equal(state.items.length, 2);
  assert.deepEqual(state.items.map(({ id }) => id), ["todo-11111111", "todo-22222222"]);
  assert.equal(state.items[0].title, "提交本周周报");
  assert.equal(state.items[0].note, "补充产品数据部分");
  assert.deepEqual(result.operations.map(({ clientId, taskId }) => [clientId, taskId]), [
    ["weekly-one", "todo-11111111"],
    ["weekly-two", "todo-22222222"],
  ]);
});

test("update、complete、reopen、archive 与 restore 维护状态时间且不物理删除", async () => {
  const target = await fixture();
  let candidatePath = await writeCandidate(target, candidate("add-task", 0, [
    { type: "add", clientId: "task", title: "初始任务", dueDate: "2026-08-24", dueTime: "15:00" },
  ]));
  await processTodoCandidate(target, candidatePath, { now, generateId: () => "todo-12345678" });

  candidatePath = await writeCandidate(target, candidate("update-task", 1, [{
    type: "update",
    taskId: "todo-12345678",
    changes: { title: "修订任务", note: "新备注", dueDate: null },
  }]));
  await processTodoCandidate(target, candidatePath, { now: "2026-08-23T19:00:00+08:00" });
  let state = await readTodoState(target);
  assert.equal(state.items[0].title, "修订任务");
  assert.equal("dueDate" in state.items[0], false);
  assert.equal("dueTime" in state.items[0], false);

  candidatePath = await writeCandidate(target, candidate("complete-task", 2, [
    { type: "complete", taskId: "todo-12345678" },
  ]));
  await processTodoCandidate(target, candidatePath, { now: "2026-08-23T20:00:00+08:00" });
  state = await readTodoState(target);
  assert.equal(state.items[0].status, "completed");
  assert.equal(state.items[0].completedAt, "2026-08-23T20:00:00+08:00");

  candidatePath = await writeCandidate(target, candidate("reopen-task", 3, [
    { type: "reopen", taskId: "todo-12345678" },
  ]));
  await processTodoCandidate(target, candidatePath, { now: "2026-08-23T20:30:00+08:00" });
  candidatePath = await writeCandidate(target, candidate("archive-task", 4, [
    { type: "archive", taskId: "todo-12345678" },
  ]));
  await processTodoCandidate(target, candidatePath, { now: "2026-08-23T21:00:00+08:00" });
  candidatePath = await writeCandidate(target, candidate("restore-task", 5, [
    { type: "restore", taskId: "todo-12345678" },
  ]));
  await processTodoCandidate(target, candidatePath, { now: "2026-08-23T21:30:00+08:00" });
  state = await readTodoState(target);

  assert.equal(state.revision, 6);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].status, "open");
  assert.equal(state.items[0].completedAt, null);
  assert.equal(state.items[0].archivedAt, null);
  assert.equal(state.items[0].createdAt, now);
});

test("全部 no-op 返回 unchanged，重复 Candidate 幂等且不增加 revision", async () => {
  const target = await fixture();
  let candidatePath = await writeCandidate(target, candidate("add-noop", 0, [
    { type: "add", clientId: "one", title: "任务" },
  ]));
  await processTodoCandidate(target, candidatePath, { now, generateId: () => "todo-abcdef12" });
  candidatePath = await writeCandidate(target, candidate("complete-once", 1, [
    { type: "complete", taskId: "todo-abcdef12" },
  ]));
  await processTodoCandidate(target, candidatePath, { now: "2026-08-23T19:00:00+08:00" });
  const noOpPath = await writeCandidate(target, candidate("complete-again", 2, [
    { type: "complete", taskId: "todo-abcdef12" },
  ]));
  const first = await processTodoCandidate(target, noOpPath, { now: "2026-08-23T20:00:00+08:00" });
  const repeated = await processTodoCandidate(target, noOpPath, { now: "2026-08-23T21:00:00+08:00" });
  const state = await readTodoState(target);

  assert.equal(first.result, "unchanged");
  assert.deepEqual(repeated, first);
  assert.equal(state.revision, 2);
});

test("revision 冲突与多操作中的未知 ID 整份拒绝，正式 State 保持不变", async () => {
  const target = await fixture();
  const before = await readFile(path.join(target, "todo", "data", "state.json"), "utf8");
  let candidatePath = await writeCandidate(target, candidate("revision-conflict", 9, [
    { type: "add", clientId: "bad", title: "不能写入" },
  ]));
  let status = await processTodoCandidate(target, candidatePath, { now });
  assert.equal(status.result, "rejected");
  assert.equal(status.field, "baseRevision");
  assert.equal(await readFile(path.join(target, "todo", "data", "state.json"), "utf8"), before);

  candidatePath = await writeCandidate(target, candidate("atomic-reject", 0, [
    { type: "add", clientId: "first", title: "第一条不应部分写入" },
    { type: "complete", taskId: "todo-deadbeef" },
  ]));
  status = await processTodoCandidate(target, candidatePath, { now, generateId: () => "todo-11111111" });
  assert.equal(status.result, "rejected");
  assert.match(status.field, /operations\.1\.taskId/);
  assert.equal(await readFile(path.join(target, "todo", "data", "state.json"), "utf8"), before);
});

test("安装级 Todo 锁拒绝并发写入，且不复用 Publication 日期锁", async () => {
  const target = await fixture();
  const lockDir = path.join(target, "todo", "data", ".locks");
  await writeFile(path.join(lockDir, "todo.lock"), "another-process\n");
  const candidatePath = await writeCandidate(target, candidate("locked-candidate", 0, [
    { type: "add", clientId: "one", title: "不会写入" },
  ]));

  await assert.rejects(() => processTodoCandidate(target, candidatePath, { now }), /已有 Todo 写入流程/);
  assert.equal((await readTodoState(target)).revision, 0);
  assert.equal(await readFile(path.join(lockDir, "todo.lock"), "utf8"), "another-process\n");
});

test("Candidate 严格拒绝非法日期、无日期时间、未知字段、重复目标和物理删除", () => {
  const base = candidate("invalid-candidate", 0, [{ type: "add", clientId: "one", title: "任务" }]);
  assert.throws(() => validateTodoCandidate({ ...base, targetTodo: "second" }), /targetTodo.*不允许/);
  assert.throws(() => validateTodoCandidate(candidate("bad-date", 0, [
    { type: "add", clientId: "one", title: "任务", dueDate: "2026-02-30" },
  ])), /真实日历日期/);
  assert.throws(() => validateTodoCandidate(candidate("bad-time", 0, [
    { type: "add", clientId: "one", title: "任务", dueTime: "10:00" },
  ])), /dueTime.*dueDate/);
  assert.throws(() => validateTodoCandidate(candidate("delete-task", 0, [
    { type: "delete", taskId: "todo-12345678" },
  ])), /add、update、complete、reopen、archive 或 restore/);
  assert.throws(() => validateTodoCandidate(candidate("duplicate-task", 0, [
    { type: "complete", taskId: "todo-12345678" },
    { type: "archive", taskId: "todo-12345678" },
  ])), /重复操作/);
  assert.throws(() => validateTodoCandidate(candidate("unknown-change", 0, [{
    type: "update",
    taskId: "todo-12345678",
    changes: { priority: "high" },
  }])), /priority.*不允许/);
  assert.throws(() => validateTodoCandidate(candidate("empty-title", 0, [
    { type: "add", clientId: "one", title: "   " },
  ])), /title.*不能为空/);
  assert.throws(() => validateTodoCandidate(candidate("long-note", 0, [
    { type: "add", clientId: "one", title: "任务", note: "字".repeat(501) },
  ])), /note.*500/);
});

test("损坏 State 保留原文件并失败，Candidate 不能越过唯一 Todo 根目录", async () => {
  const target = await fixture();
  const statePath = path.join(target, "todo", "data", "state.json");
  await writeFile(statePath, "{ broken");
  await assert.rejects(() => readTodoState(target), /state.*合法 JSON/);
  assert.equal(await readFile(statePath, "utf8"), "{ broken");

  const outside = path.join(target, "outside.json");
  await writeFile(outside, `${JSON.stringify(candidate("outside", 0, [
    { type: "add", clientId: "one", title: "越界" },
  ]))}\n`);
  await assert.rejects(() => processTodoCandidate(target, outside), /candidates/);
});

test("Todo 数据目录和 State 不能通过符号链接越过项目根目录", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-todo-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "daily-news-todo-outside-"));
  await mkdir(path.join(target, "config"), { recursive: true });
  await mkdir(path.join(target, "todo"), { recursive: true });
  await writeFile(path.join(target, "config", "todo.json"), '{"schemaVersion":1,"enabled":true}\n');
  await symlink(outside, path.join(target, "todo", "data"));
  await assert.rejects(() => ensureTodoData(target), /符号链接/);
});

test("无效 JSON Candidate 记录 rejected Submission 且不修改 State", async () => {
  const target = await fixture();
  const candidatePath = await writeCandidate(target, { candidateId: "broken-json" }, "{ broken");
  const status = await processTodoCandidate(target, candidatePath, { now });
  assert.equal(status.result, "rejected");
  assert.equal(status.field, "candidate");
  assert.equal((await readTodoState(target)).revision, 0);
  assert.deepEqual(
    await readJson(path.join(target, "todo", "data", "submissions", "broken-json.json")),
    status,
  );
});

test("State 校验把 HTML 和脚本当普通文本，同时拒绝状态结构注入", async () => {
  const target = await fixture();
  const candidatePath = await writeCandidate(target, candidate("text-safety", 0, [{
    type: "add",
    clientId: "probe",
    title: "<script>alert('x')</script>",
    note: "<img src=x onerror=alert(1)>",
  }]));
  await processTodoCandidate(target, candidatePath, { now, generateId: () => "todo-87654321" });
  const state = await readTodoState(target);
  assert.equal(state.items[0].title, "<script>alert('x')</script>");
  assert.throws(() => validateTodoState({ ...state, publicationId: "daily-news" }), /publicationId.*不允许/);
});

test("宿主启动扫描 Candidate，日志只包含 ID、revision、操作数量和结果", async () => {
  const target = await fixture();
  const probe = "PRIVATE-TODO-PROBE-DO-NOT-LOG";
  await writeCandidate(target, candidate("host-candidate", 0, [
    { type: "add", clientId: "one", title: probe },
  ]));
  const records = [];
  await startTodoHost(target, {
    watch: false,
    now,
    generateId: () => "todo-11112222",
    onStatus: (status) => records.push(todoLogRecord(status)),
  });
  assert.deepEqual(records, [{
    candidateId: "host-candidate",
    revision: 1,
    operationCount: 1,
    result: "published",
  }]);
  assert.doesNotMatch(JSON.stringify(records), new RegExp(probe));
});

test("运行中的宿主监听新完成的 Candidate 并自动处理", async () => {
  const target = await fixture();
  let resolvePublished;
  const published = new Promise((resolve) => { resolvePublished = resolve; });
  const host = await startTodoHost(target, {
    now,
    generateId: () => "todo-33334444",
    debounceMs: 20,
    pollMs: 25,
    onStatus: (status) => {
      if (status.result === "published") resolvePublished(status);
    },
  });
  try {
    await writeCandidate(target, candidate("watched-candidate", 0, [
      { type: "add", clientId: "watch", title: "监听任务" },
    ]));
    let timeout;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Todo 监听处理超时")), 2000);
    });
    const status = await Promise.race([published, timedOut]).finally(() => clearTimeout(timeout));
    assert.equal(status.revision, 1);
    assert.equal((await readTodoState(target)).items[0].id, "todo-33334444");
  } finally {
    host.close();
  }
});

test("process-todo 命令输出 published 与正式 ID，不输出任务正文", async () => {
  const target = await fixture();
  const candidatePath = await writeCandidate(target, candidate("cli-candidate", 0, [
    { type: "add", clientId: "cli", title: "CLI 私人探针" },
  ]));
  await cp(path.join(rootDir, "scripts"), path.join(target, "scripts"), { recursive: true });
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(target, "scripts", "process-todo.js"),
    "--candidate",
    candidatePath,
  ]);
  const output = JSON.parse(stdout);
  assert.equal(output.result, "published");
  assert.equal(output.pageUrl, "/todo/");
  assert.equal(output.operations[0].clientId, "cli");
  assert.match(output.operations[0].taskId, /^todo-[a-f0-9]{8}$/);
  assert.doesNotMatch(stdout, /CLI 私人探针/);
});

test("Todo 私有目录规则覆盖 State、Candidate、Submission 与锁", async () => {
  const ignore = await readFile(path.join(rootDir, ".gitignore"), "utf8");
  for (const pattern of [
    "todo/data/state.json",
    "todo/data/candidates/*.json",
    "todo/data/submissions/*.json",
    "todo/data/.locks/",
  ]) {
    assert.match(ignore, new RegExp(pattern.replaceAll("*", "\\*")));
  }
});
