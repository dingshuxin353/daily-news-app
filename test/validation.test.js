import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAdjacentDates, selectDate } from "../src/app.js";
import { ValidationError, validateAll } from "../scripts/lib/validation.js";
import { writeIssue } from "../scripts/lib/writer.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-test-"));
  for (const entry of ["config", "data", "public"]) {
    await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
  }
  return target;
}

async function editIssue(target, date, mutate) {
  const filePath = path.join(target, "data", "issues", `${date}.json`);
  const issue = JSON.parse(await readFile(filePath, "utf8"));
  mutate(issue);
  await writeFile(filePath, JSON.stringify(issue), "utf8");
}

test("现有站点配置和两期源日报通过校验并生成倒序索引", async () => {
  assert.deepEqual(await validateAll(rootDir), {
    latest: "2026-08-19",
    dates: ["2026-08-19", "2026-08-18"],
  });
});

test("新增第三份合法日报会自动进入索引", async () => {
  const target = await fixture();
  const sourcePath = path.join(target, "data", "issues", "2026-08-19.json");
  const issue = JSON.parse(await readFile(sourcePath, "utf8"));
  issue.date = "2026-08-20";
  issue.generatedAt = "2026-08-20T08:00:00+08:00";
  await writeFile(path.join(target, "data", "issues", "2026-08-20.json"), JSON.stringify(issue), "utf8");

  assert.deepEqual(await validateAll(target), {
    latest: "2026-08-20",
    dates: ["2026-08-20", "2026-08-19", "2026-08-18"],
  });
});

test("editorial.priority 缺失时指出文件、字段和内容 ID", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-19", (issue) => delete issue.items[0].editorial.priority);
  await assert.rejects(() => validateAll(target), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.match(error.message, /2026-08-19\.json.*items\[0\]\.editorial\.priority.*scheduled-agent-workflow/);
    return true;
  });
});

test("editorial.priority 只能是 lead、important 或 normal", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-19", (issue) => {
    issue.items[0].editorial.priority = "urgent";
  });
  await assert.rejects(() => validateAll(target), /editorial\.priority.*只能是 lead、important 或 normal/);
});

test("同一期日报的内容 ID 不能重复", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-19", (issue) => {
    issue.items[1].id = issue.items[0].id;
  });
  await assert.rejects(() => validateAll(target), /items\[1\]\.id.*不能重复/);
});

test("schemaVersion 必须为 1，内容 ID 必须使用小写连字符格式", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-19", (issue) => {
    issue.schemaVersion = 2;
  });
  await assert.rejects(() => validateAll(target), /schemaVersion 必须等于 1/);

  await editIssue(target, "2026-08-19", (issue) => {
    issue.schemaVersion = 1;
    issue.items[0].id = "Invalid_ID";
  });
  await assert.rejects(() => validateAll(target), /items\[0\]\.id.*小写字母、数字和连字符/);
});

test("日报日期必须与文件名一致", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-18", (issue) => {
    issue.date = "2026-08-17";
  });
  await assert.rejects(() => validateAll(target), /date 必须与文件名一致/);
});

test("来源地址只接受 HTTP 或 HTTPS", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-18", (issue) => {
    issue.items[0].sources[0].url = "javascript:alert(1)";
  });
  await assert.rejects(() => validateAll(target), /sources\[0\]\.url.*http:\/\/ 或 https:\/\//);
});

test("sources 必须非空且同一内容内 URL 不可重复", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-18", (issue) => {
    issue.items[0].sources = [];
  });
  await assert.rejects(() => validateAll(target), /sources.*必须是非空数组/);

  await editIssue(target, "2026-08-18", (issue) => {
    issue.items[0].sources = [
      { name: "A", url: "https://example.com/source" },
      { name: "B", url: "https://example.com/source" },
    ];
  });
  await assert.rejects(() => validateAll(target), /sources\[1\]\.url.*不能重复/);
});

test("via 必须同时提供合法名称和 HTTP(S) 地址", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-18", (issue) => {
    issue.items[0].sources[0].via = { name: "AIHot" };
  });
  await assert.rejects(() => validateAll(target), /via\.url.*非空字符串/);
});

test("AIHot 的 score 与 selected 不进入正式日报", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-18", (issue) => {
    issue.items[0].score = 99;
  });
  await assert.rejects(() => validateAll(target), /不能包含 AIHot 的 score 或 selected/);
});

test("Agent 只在完整候选通过校验后原子替换日报", async () => {
  const target = await fixture();
  const existingPath = path.join(target, "data", "issues", "2026-08-19.json");
  const before = await readFile(existingPath, "utf8");
  const candidatePath = path.join(target, "candidate.json");
  await assert.rejects(() => writeIssue(target, "../invalid", candidatePath), /目标日期/);
  const invalid = JSON.parse(before);
  delete invalid.items[0].brief;
  await writeFile(candidatePath, JSON.stringify(invalid), "utf8");

  await assert.rejects(() => writeIssue(target, "2026-08-19", candidatePath), /brief/);
  assert.equal(await readFile(existingPath, "utf8"), before);

  const valid = JSON.parse(before);
  valid.date = "2026-08-20";
  valid.generatedAt = "2026-08-20T08:00:00+08:00";
  await writeFile(candidatePath, JSON.stringify(valid, null, 2), "utf8");
  const writtenPath = await writeIssue(target, "2026-08-20", candidatePath);
  assert.deepEqual(JSON.parse(await readFile(writtenPath, "utf8")), valid);
});

test("无效或不存在的日期回退到最新一期", () => {
  const index = { latest: "2026-08-19", dates: ["2026-08-19", "2026-08-18"] };
  assert.equal(selectDate("", index), "2026-08-19");
  assert.equal(selectDate("?date=not-a-date", index), "2026-08-19");
  assert.equal(selectDate("?date=2026-08-17", index), "2026-08-19");
  assert.equal(selectDate("?date=2026-08-18", index), "2026-08-18");
});

test("日期导航按索引相邻项启用和禁用", () => {
  const dates = ["2026-08-19", "2026-08-18"];
  assert.deepEqual(getAdjacentDates("2026-08-19", dates), {
    previous: "2026-08-18",
    next: null,
  });
  assert.deepEqual(getAdjacentDates("2026-08-18", dates), {
    previous: null,
    next: "2026-08-19",
  });
});
