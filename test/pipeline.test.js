import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { processCandidate } from "../scripts/lib/pipeline.js";
import { seedTestData } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const publicationId = "ai-daily";

function publicationDir(target) {
  return path.join(target, "publications", publicationId);
}

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-pipeline-"));
  for (const entry of ["index.html", "home.html", "styles.css", "src", "public", "themes"]) {
    await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
  }
  await mkdir(path.join(target, "config"), { recursive: true });
  await writeFile(path.join(target, "config", "publications.json"), JSON.stringify({
    schemaVersion: 1,
    defaultPublicationId: publicationId,
    publicationIds: [publicationId],
  }), "utf8");
  await cp(path.join(rootDir, "config", "home.json"), path.join(target, "config", "home.json"));
  await cp(path.join(rootDir, "config", "todo.json"), path.join(target, "config", "todo.json"));
  const targetPublication = publicationDir(target);
  await mkdir(path.join(targetPublication, "config"), { recursive: true });
  await mkdir(path.join(targetPublication, "themes"), { recursive: true });
  await mkdir(path.join(targetPublication, "data", "submissions"), { recursive: true });
  await cp(path.join(rootDir, "config", "site.json"), path.join(targetPublication, "config", "site.json"));
  await cp(path.join(rootDir, "config", "theme.json"), path.join(targetPublication, "config", "theme.json"));
  await cp(path.join(rootDir, "themes", "active.json"), path.join(targetPublication, "themes", "active.json"));
  await seedTestData(targetPublication);
  return target;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function candidateFromIssue(issue) {
  return {
    schemaVersion: issue.schemaVersion,
    date: issue.date,
    generatedAt: issue.generatedAt,
    coverage: structuredClone(issue.coverage),
    items: structuredClone(issue.items),
  };
}

async function writeCandidate(target, candidate) {
  const candidatePath = path.join(publicationDir(target), "data", "candidates", `${candidate.date}.json`);
  await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  return candidatePath;
}

async function readIssue(target, date) {
  return readJson(path.join(publicationDir(target), "data", "issues", `${date}.json`));
}

async function snapshot(target, date) {
  const files = [
    path.join(publicationDir(target), "data", "issues", `${date}.json`),
    path.join(publicationDir(target), "data", "compiled", `${date}.json`),
    path.join(publicationDir(target), "data", "index.json"),
  ];
  return Promise.all(files.map((filePath) => readFile(filePath, "utf8")));
}

test("新日期返回 created，并统一写入 issue、compiled 和 index", async () => {
  const target = await fixture();
  const source = await readIssue(target, "2026-08-19");
  const candidate = candidateFromIssue(source);
  candidate.date = "2026-08-20";
  candidate.generatedAt = "2026-08-20T08:00:00+08:00";
  candidate.coverage = {
    start: "2026-08-19T08:00:00+08:00",
    end: "2026-08-20T08:00:00+08:00",
  };
  const candidatePath = await writeCandidate(target, candidate);

  const result = await processCandidate(target, publicationId, candidatePath, { today: "2026-08-20" });
  const issue = await readIssue(target, "2026-08-20");
  const compiled = await readJson(path.join(publicationDir(target), "data", "compiled", "2026-08-20.json"));
  const index = await readJson(path.join(publicationDir(target), "data", "index.json"));

  assert.equal(result.result, "created");
  assert.equal(issue.revision, 1);
  assert.equal(compiled.revision, 1);
  assert.deepEqual(compiled.coverage, candidate.coverage);
  assert.equal(compiled.items.length, issue.items.length);
  assert.equal(index.latest, "2026-08-20");
  assert.equal(index.dates.includes("2026-08-20"), true);
});

test("update 按来源 URL 匹配并复用稳定 ID，保留旧来源和未匹配内容", async () => {
  const target = await fixture();
  const existing = await readIssue(target, "2026-08-19");
  const candidate = candidateFromIssue(existing);
  candidate.generatedAt = "2026-08-19T09:00:00+08:00";
  candidate.items = [structuredClone(existing.items[0])];
  candidate.items[0].id = "candidate-renamed-id";
  candidate.items[0].brief = "候选更新后的短摘要。";
  candidate.items[0].sources = [candidate.items[0].sources[0]];
  const candidatePath = await writeCandidate(target, candidate);

  const result = await processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" });
  const issue = await readIssue(target, "2026-08-19");

  assert.equal(result.result, "updated");
  assert.equal(issue.revision, 2);
  assert.equal(issue.items.length, existing.items.length);
  assert.equal(issue.items[0].id, existing.items[0].id);
  assert.equal(issue.items[0].brief, "候选更新后的短摘要。");
  assert.equal(issue.items[0].sources.length, 2);
  assert.deepEqual(
    issue.items.slice(1).map(({ id }) => id),
    existing.items.slice(1).map(({ id }) => id),
  );
});

test("Schema 2 图片新增、替换、移除会升级 revision，未匹配条目保留图片", async () => {
  const target = await fixture();
  const existing = await readIssue(target, "2026-08-19");
  const candidate = candidateFromIssue(existing);
  candidate.schemaVersion = 2;
  candidate.generatedAt = "2026-08-19T09:00:00+08:00";
  candidate.items[0].image = {
    src: "https://cdn.example.com/first.jpg",
    alt: "第一张测试图片",
    width: 1200,
    height: 800,
    credit: "测试来源",
  };
  candidate.items[1].image = {
    src: "https://cdn.example.com/second.jpg",
    alt: "第二张测试图片",
    width: 1200,
    height: 800,
    credit: "测试来源",
  };
  let candidatePath = await writeCandidate(target, candidate);
  let result = await processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" });
  let issue = await readIssue(target, "2026-08-19");
  assert.equal(result.result, "updated");
  assert.equal(issue.schemaVersion, 2);
  assert.equal(issue.revision, 2);

  const next = candidateFromIssue(issue);
  next.generatedAt = "2026-08-19T10:00:00+08:00";
  next.items = [structuredClone(issue.items[0])];
  next.items[0].image.credit = "替换后的署名";
  candidatePath = await writeCandidate(target, next);
  result = await processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" });
  issue = await readIssue(target, "2026-08-19");
  assert.equal(result.revision, 3);
  assert.equal(issue.items[0].image.credit, "替换后的署名");
  assert.equal(issue.items[1].image.src, "https://cdn.example.com/second.jpg");

  const remove = candidateFromIssue(issue);
  remove.generatedAt = "2026-08-19T11:00:00+08:00";
  delete remove.items[0].image;
  candidatePath = await writeCandidate(target, remove);
  result = await processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" });
  issue = await readIssue(target, "2026-08-19");
  assert.equal(result.revision, 4);
  assert.equal("image" in issue.items[0], false);
});

test("Schema 1 Candidate 不能更新 Schema 2 Issue", async () => {
  const target = await fixture();
  const issuePath = path.join(publicationDir(target), "data", "issues", "2026-08-19.json");
  const existing = await readJson(issuePath);
  existing.schemaVersion = 2;
  await writeFile(issuePath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  const candidate = candidateFromIssue(existing);
  candidate.schemaVersion = 1;
  const candidatePath = await writeCandidate(target, candidate);
  const before = await snapshot(target, "2026-08-19");
  await assert.rejects(
    () => processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" }),
    /Schema 1 Candidate 不能更新 Schema 2 Issue/,
  );
  assert.deepEqual(await snapshot(target, "2026-08-19"), before);
});

test("replace 只有显式模式才删除候选未包含的旧内容", async () => {
  const target = await fixture();
  const existing = await readIssue(target, "2026-08-19");
  const candidate = candidateFromIssue(existing);
  candidate.items = [candidate.items[0]];
  const candidatePath = await writeCandidate(target, candidate);

  const result = await processCandidate(target, publicationId, candidatePath, {
    today: "2026-08-19",
    mode: "replace",
    allowReplace: true,
  });
  const issue = await readIssue(target, "2026-08-19");

  assert.equal(result.result, "updated");
  assert.equal(issue.revision, 2);
  assert.equal(issue.items.length, 1);
});

test("replace 未显式授权时返回 authorization_required 且不写正式产物", async () => {
  const target = await fixture();
  const existing = await readIssue(target, "2026-08-19");
  const candidate = candidateFromIssue(existing);
  candidate.items = [candidate.items[0]];
  const candidatePath = await writeCandidate(target, candidate);
  const before = await snapshot(target, "2026-08-19");

  await assert.rejects(
    () => processCandidate(target, publicationId, candidatePath, {
      today: "2026-08-19",
      mode: "replace",
    }),
    (error) => error.result === "authorization_required" && /--allow-replace/.test(error.message),
  );
  assert.deepEqual(await snapshot(target, "2026-08-19"), before);
});

test("无业务变化保留 generatedAt 和 revision，仅修复过期 compiled 与 index", async () => {
  const target = await fixture();
  const existingPath = path.join(publicationDir(target), "data", "issues", "2026-08-19.json");
  const existingSource = await readFile(existingPath, "utf8");
  const existing = JSON.parse(existingSource);
  const candidate = candidateFromIssue(existing);
  candidate.generatedAt = "2026-08-19T10:00:00+08:00";
  const candidatePath = await writeCandidate(target, candidate);
  await writeFile(
    path.join(publicationDir(target), "data", "compiled", "2026-08-19.json"),
    "{invalid",
    "utf8",
  );
  await writeFile(
    path.join(publicationDir(target), "data", "index.json"),
    "{invalid",
    "utf8",
  );

  const result = await processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" });
  const issue = await readIssue(target, "2026-08-19");
  const compiled = await readJson(path.join(publicationDir(target), "data", "compiled", "2026-08-19.json"));

  assert.equal(result.result, "unchanged");
  assert.deepEqual(result.repaired.sort(), ["compiled", "index"]);
  assert.equal(await readFile(existingPath, "utf8"), existingSource);
  assert.equal(issue.generatedAt, existing.generatedAt);
  assert.equal(issue.revision, existing.revision);
  assert.equal(compiled.revision, existing.revision);
});

test("站点数量配置改变后，unchanged 会按新限制修复 compiled", async () => {
  const target = await fixture();
  const existing = await readIssue(target, "2026-08-19");
  const candidatePath = await writeCandidate(target, candidateFromIssue(existing));
  const configPath = path.join(publicationDir(target), "config", "site.json");
  const site = await readJson(configPath);
  site.priorityLimits.important = 0;
  await writeFile(configPath, `${JSON.stringify(site, null, 2)}\n`, "utf8");

  const result = await processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" });
  const compiled = await readJson(path.join(publicationDir(target), "data", "compiled", "2026-08-19.json"));
  const modules = compiled.layout.rows.flatMap(({ modules: rowModules }) => rowModules);

  assert.equal(result.result, "unchanged");
  assert.deepEqual(result.repaired, ["compiled"]);
  assert.equal(modules.some(({ size }) => size === "medium"), false);
  assert.equal(modules.filter(({ size }) => size === "small").length, 5);
});

test("coverage 改变或匹配歧义时拒绝并保持全部正式产物不变", async () => {
  const target = await fixture();
  const existing = await readIssue(target, "2026-08-19");
  const before = await snapshot(target, "2026-08-19");
  const candidate = candidateFromIssue(existing);
  candidate.coverage.start = "2026-08-18T07:00:00+08:00";
  let candidatePath = await writeCandidate(target, candidate);

  await assert.rejects(
    () => processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" }),
    /coverage.*固定采集窗口/,
  );
  assert.deepEqual(await snapshot(target, "2026-08-19"), before);

  candidate.coverage = structuredClone(existing.coverage);
  candidate.items = [structuredClone(existing.items[0])];
  candidate.items[0].sources = [structuredClone(existing.items[1].sources[0])];
  candidatePath = await writeCandidate(target, candidate);
  await assert.rejects(
    () => processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" }),
    /命中了多个已有条目/,
  );
  assert.deepEqual(await snapshot(target, "2026-08-19"), before);
});

test("历史日期未授权和同日期锁冲突均拒绝写入", async () => {
  const target = await fixture();
  const existing = await readIssue(target, "2026-08-19");
  const candidatePath = await writeCandidate(target, candidateFromIssue(existing));
  const before = await snapshot(target, "2026-08-19");

  await assert.rejects(
    () => processCandidate(target, publicationId, candidatePath, { today: "2026-08-20" }),
    /--allow-history/,
  );

  const lockDir = path.join(publicationDir(target), "data", ".locks");
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "2026-08-19.lock"), "held\n", "utf8");
  await assert.rejects(
    () => processCandidate(target, publicationId, candidatePath, { today: "2026-08-19" }),
    /已有写入流程/,
  );
  assert.deepEqual(await snapshot(target, "2026-08-19"), before);
});

test("候选必须位于 data/candidates 目录", async () => {
  const target = await fixture();
  const existing = await readIssue(target, "2026-08-19");
  const outsidePath = path.join(target, "candidate.json");
  await writeFile(outsidePath, JSON.stringify(candidateFromIssue(existing)), "utf8");
  await assert.rejects(
    () => processCandidate(target, publicationId, outsidePath, { today: "2026-08-19" }),
    /必须位于 Publication ai-daily 的 data\/candidates/,
  );
});

test("process-candidate 宿主命令输出 published 与完整页面状态", async () => {
  const target = await fixture();
  await cp(path.join(rootDir, "scripts"), path.join(target, "scripts"), { recursive: true });
  const existing = await readIssue(target, "2026-08-19");
  const candidatePath = await writeCandidate(target, candidateFromIssue(existing));
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(target, "scripts", "process-candidate.js"),
    "--candidate",
    candidatePath,
    "--publication",
    publicationId,
    "--mode",
    "update",
    "--allow-history",
  ], { cwd: target });
  const result = JSON.parse(stdout);
  assert.equal(result.result, "published");
  assert.equal(result.writerResult, "unchanged");
  assert.equal(result.publicationId, publicationId);
  assert.equal(result.date, "2026-08-19");
  assert.equal(result.revision, existing.revision);
  assert.equal(result.pageUrl, "/p/ai-daily/?date=2026-08-19");
  assert.match(
    await readFile(path.join(target, "dist", "p", publicationId, "index.html"), "utf8"),
    /2026-08-19/,
  );
});
