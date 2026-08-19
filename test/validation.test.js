import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAdjacentDates, selectDate } from "../src/app.js";
import { ValidationError, validateAll } from "../scripts/lib/validation.js";

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

test("现有站点配置和两期日报通过校验并生成倒序索引", async () => {
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
  await writeFile(
    path.join(target, "data", "issues", "2026-08-20.json"),
    JSON.stringify(issue),
    "utf8",
  );

  assert.deepEqual(await validateAll(target), {
    latest: "2026-08-20",
    dates: ["2026-08-20", "2026-08-19", "2026-08-18"],
  });
});

test("同一期日报的内容 ID 不能重复", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-19", (issue) => {
    issue.items[1].id = issue.items[0].id;
  });
  await assert.rejects(() => validateAll(target), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.match(error.message, /items\[1\]\.id.*不能重复/);
    return true;
  });
});

test("日报日期必须与文件名一致", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-18", (issue) => {
    issue.date = "2026-08-17";
  });
  await assert.rejects(() => validateAll(target), /date 必须与文件名一致/);
});

test("本地图片路径必须存在", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-18", (issue) => {
    issue.items[0].image = "/mock-images/missing.svg";
  });
  await assert.rejects(() => validateAll(target), /items\[0\]\.image.*本地文件不存在/);
});

test("来源地址只接受 HTTP 或 HTTPS", async () => {
  const target = await fixture();
  await editIssue(target, "2026-08-18", (issue) => {
    issue.items[0].source.url = "javascript:alert(1)";
  });
  await assert.rejects(() => validateAll(target), /source\.url.*http:\/\/ 或 https:\/\//);
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
