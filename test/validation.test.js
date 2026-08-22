import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyTitleLength,
  getAdjacentDates,
  selectDate,
  selectThemeRequest,
} from "../src/app.js";
import {
  ValidationError,
  validateAll,
  validateCandidate,
  validateSite,
} from "../scripts/lib/validation.js";
import { seedTestData } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-test-"));
  for (const entry of ["config", "public"]) {
    await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
  }
  await seedTestData(target);
  return target;
}

async function editIssue(target, date, mutate) {
  const filePath = path.join(target, "data", "issues", `${date}.json`);
  const issue = JSON.parse(await readFile(filePath, "utf8"));
  mutate(issue);
  await writeFile(filePath, JSON.stringify(issue), "utf8");
}

test("无业务数据的主仓通过校验并生成空索引", async () => {
  assert.deepEqual(await validateAll(rootDir), {
    latest: null,
    dates: [],
  });
});

test("运行时测试数据通过校验并生成倒序索引", async () => {
  const target = await fixture();
  assert.deepEqual(await validateAll(target), {
    latest: "2026-08-19",
    dates: ["2026-08-19", "2026-08-18"],
  });
});

test("三档优先级数量限制必须是非负整数或 null", async () => {
  const target = await fixture();
  const configPath = path.join(target, "config", "site.json");
  const site = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual((await validateSite(target)).priorityLimits, {
    lead: 1,
    important: 2,
    normal: null,
  });

  site.priorityLimits.important = -1;
  await writeFile(configPath, JSON.stringify(site), "utf8");
  await assert.rejects(() => validateSite(target), /priorityLimits\.important.*大于等于 0/);

  site.priorityLimits.important = 2;
  delete site.priorityLimits.normal;
  await writeFile(configPath, JSON.stringify(site), "utf8");
  await assert.rejects(() => validateSite(target), /priorityLimits\.normal.*整数或 null/);
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
    assert.match(error.message, /2026-08-19\.json.*items\[0\]\.editorial\.priority.*test-item-1/);
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

test("候选要求固定 coverage 且禁止 revision 和布局字段", async () => {
  const target = await fixture();
  const source = JSON.parse(await readFile(path.join(target, "data", "issues", "2026-08-19.json"), "utf8"));
  delete source.revision;
  const candidateDir = path.join(target, "data", "candidates");
  await mkdir(candidateDir, { recursive: true });
  const candidatePath = path.join(candidateDir, "2026-08-19.json");
  await writeFile(candidatePath, JSON.stringify(source), "utf8");
  assert.equal((await validateCandidate(candidatePath)).date, "2026-08-19");

  source.revision = 1;
  await writeFile(candidatePath, JSON.stringify(source), "utf8");
  await assert.rejects(() => validateCandidate(candidatePath), /revision.*不允许出现在候选中/);

  delete source.revision;
  source.coverage.end = source.coverage.start;
  await writeFile(candidatePath, JSON.stringify(source), "utf8");
  await assert.rejects(() => validateCandidate(candidatePath), /coverage.*start 必须早于 end/);
});

test("Candidate Schema 保持 1，不能通过 publicationId 自行指定写入目标", async () => {
  const target = await fixture();
  const source = JSON.parse(await readFile(path.join(target, "data", "issues", "2026-08-19.json"), "utf8"));
  delete source.revision;
  source.publicationId = "finance-daily";
  const candidatePath = path.join(target, "data", "candidates", "2026-08-19.json");
  await writeFile(candidatePath, JSON.stringify(source), "utf8");

  await assert.rejects(
    () => validateCandidate(candidatePath),
    /publicationId.*不允许出现在候选中/,
  );
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

test("主题预览参数只接受安全的主题 ID", () => {
  assert.equal(selectThemeRequest("?themePreview=blue-finance"), "blue-finance");
  assert.equal(selectThemeRequest("?themePreview=../../active"), null);
  assert.equal(selectThemeRequest("?themePreview=https://example.com/theme"), null);
});

test("头条长度按 Unicode code point 在 28 和 40 字边界分档", () => {
  assert.equal(classifyTitleLength(`  ${"新".repeat(28)}  `), "standard");
  assert.equal(classifyTitleLength("新".repeat(29)), "long");
  assert.equal(classifyTitleLength("A".repeat(39) + "🚀"), "long");
  assert.equal(classifyTitleLength("新".repeat(41)), "extra-long");
});
