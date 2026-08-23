import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { processCandidate } from "../scripts/lib/pipeline.js";
import { loadPublicationRegistry } from "../scripts/lib/publications.js";
import { inheritTheme, switchTheme, validateConfiguredTheme } from "../scripts/lib/theme-pipeline.js";
import { switchHomeTheme } from "../scripts/lib/home.js";
import { seedTestData } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function publicationDir(target, publicationId) {
  return path.join(target, "publications", publicationId);
}

async function createPublication(target, publicationId) {
  const directory = publicationDir(target, publicationId);
  await mkdir(path.join(directory, "config"), { recursive: true });
  await mkdir(path.join(directory, "themes"), { recursive: true });
  await mkdir(path.join(directory, "data", "submissions"), { recursive: true });
  await cp(path.join(rootDir, "config", "site.json"), path.join(directory, "config", "site.json"));
  await cp(path.join(rootDir, "config", "theme.json"), path.join(directory, "config", "theme.json"));
  await cp(path.join(rootDir, "themes", "active.json"), path.join(directory, "themes", "active.json"));
  await seedTestData(directory);
  return directory;
}

async function fixture(publicationIds = ["ai-daily", "finance-daily"]) {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-publications-"));
  await cp(path.join(rootDir, "themes"), path.join(target, "themes"), { recursive: true });
  await cp(path.join(rootDir, "public"), path.join(target, "public"), { recursive: true });
  await mkdir(path.join(target, "config"), { recursive: true });
  await cp(path.join(rootDir, "config", "home.json"), path.join(target, "config", "home.json"));
  for (const publicationId of publicationIds) await createPublication(target, publicationId);
  await writeJson(path.join(target, "config", "publications.json"), {
    schemaVersion: 1,
    defaultPublicationId: publicationIds[0],
    publicationIds,
  });
  return target;
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

async function writeCandidate(target, publicationId, candidate) {
  const candidatePath = path.join(
    publicationDir(target, publicationId),
    "data",
    "candidates",
    `${candidate.date}.json`,
  );
  await writeJson(candidatePath, candidate);
  return candidatePath;
}

async function snapshot(target, publicationId, date = "2026-08-19") {
  const dataDir = path.join(publicationDir(target, publicationId), "data");
  return Promise.all([
    readFile(path.join(dataDir, "issues", `${date}.json`), "utf8"),
    readFile(path.join(dataDir, "compiled", `${date}.json`), "utf8"),
    readFile(path.join(dataDir, "index.json"), "utf8"),
  ]);
}

test("注册表加载有序 Publication，并解析独立配置、数据与主题选择目录", async () => {
  const target = await fixture();
  const registry = await loadPublicationRegistry(target);

  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.defaultPublicationId, "ai-daily");
  assert.deepEqual(registry.publicationIds, ["ai-daily", "finance-daily"]);
  assert.deepEqual(
    registry.publications.map(({ publicationId }) => publicationId),
    registry.publicationIds,
  );
  assert.notEqual(registry.publications[0].dataDir, registry.publications[1].dataDir);
  assert.notEqual(registry.publications[0].configDir, registry.publications[1].configDir);
  assert.notEqual(
    registry.publications[0].themeSelectionDir,
    registry.publications[1].themeSelectionDir,
  );
});

test("重复、非法、缺失默认项和注册表目录不一致均失败关闭", async () => {
  const cases = [
    {
      registry: {
        schemaVersion: 1,
        defaultPublicationId: "ai-daily",
        publicationIds: ["ai-daily", "ai-daily"],
      },
      pattern: /不能重复/,
    },
    {
      registry: {
        schemaVersion: 1,
        defaultPublicationId: "ai-daily",
        publicationIds: ["ai-daily", ".."],
      },
      pattern: /小写字母、数字和连字符/,
    },
    {
      registry: {
        schemaVersion: 1,
        defaultPublicationId: "missing",
        publicationIds: ["ai-daily"],
      },
      pattern: /必须属于 publicationIds/,
    },
    {
      registry: {
        schemaVersion: 1,
        defaultPublicationId: "ai-daily",
        publicationIds: ["ai-daily"],
      },
      pattern: /finance-daily.*未在注册表中登记/,
    },
  ];

  for (const { registry, pattern } of cases) {
    const target = await fixture();
    await writeJson(path.join(target, "config", "publications.json"), registry);
    await assert.rejects(() => loadPublicationRegistry(target), pattern);
  }
});

test("Publication 内部配置和数据目录不能通过符号链接越界", async () => {
  const target = await fixture();
  const candidateDir = path.join(publicationDir(target, "ai-daily"), "data", "candidates");
  await rm(candidateDir, { recursive: true });
  await symlink(
    path.join(publicationDir(target, "finance-daily"), "data", "candidates"),
    candidateDir,
  );

  await assert.rejects(
    () => loadPublicationRegistry(target),
    /data\/candidates.*越过 Publication 边界/,
  );
});

test("同日同 ID 与来源只在目标 Publication 内匹配和增加 revision", async () => {
  const target = await fixture();
  const aiIssuePath = path.join(publicationDir(target, "ai-daily"), "data", "issues", "2026-08-19.json");
  const aiIssue = await readJson(aiIssuePath);
  const candidate = candidateFromIssue(aiIssue);
  candidate.generatedAt = "2026-08-19T09:00:00+08:00";
  candidate.items[0].brief = "只属于 AI 日报的更新。";
  const candidatePath = await writeCandidate(target, "ai-daily", candidate);
  const financeBefore = await snapshot(target, "finance-daily");

  const result = await processCandidate(target, "ai-daily", candidatePath, {
    today: "2026-08-19",
  });
  const updatedAi = await readJson(aiIssuePath);

  assert.equal(result.publicationId, "ai-daily");
  assert.equal(result.result, "updated");
  assert.equal(updatedAi.revision, 2);
  assert.equal(updatedAi.items[0].brief, "只属于 AI 日报的更新。");
  assert.deepEqual(await snapshot(target, "finance-daily"), financeBefore);
});

test("默认 Publication 不能替缺失的写入目标隐式授权", async () => {
  const target = await fixture();
  const issue = await readJson(path.join(
    publicationDir(target, "ai-daily"),
    "data",
    "issues",
    "2026-08-19.json",
  ));
  const candidatePath = await writeCandidate(target, "ai-daily", candidateFromIssue(issue));

  await assert.rejects(
    () => processCandidate(target, undefined, candidatePath, { today: "2026-08-19" }),
    /publicationId.*小写字母、数字和连字符/,
  );
});

test("一份 Publication 的失败不改变本池既有产物或另一份 Publication", async () => {
  const target = await fixture();
  const aiIssue = await readJson(path.join(
    publicationDir(target, "ai-daily"),
    "data",
    "issues",
    "2026-08-19.json",
  ));
  const candidate = candidateFromIssue(aiIssue);
  candidate.coverage.start = "2026-08-18T07:00:00+08:00";
  const candidatePath = await writeCandidate(target, "ai-daily", candidate);
  const aiBefore = await snapshot(target, "ai-daily");
  const financeBefore = await snapshot(target, "finance-daily");

  await assert.rejects(
    () => processCandidate(target, "ai-daily", candidatePath, { today: "2026-08-19" }),
    /coverage.*固定采集窗口/,
  );
  assert.deepEqual(await snapshot(target, "ai-daily"), aiBefore);
  assert.deepEqual(await snapshot(target, "finance-daily"), financeBefore);
});

test("Candidate 目录不能越过显式目标，日期锁按 Publication 隔离", async () => {
  const target = await fixture();
  const aiIssue = await readJson(path.join(
    publicationDir(target, "ai-daily"),
    "data",
    "issues",
    "2026-08-19.json",
  ));
  const financeIssue = await readJson(path.join(
    publicationDir(target, "finance-daily"),
    "data",
    "issues",
    "2026-08-19.json",
  ));
  const aiCandidatePath = await writeCandidate(target, "ai-daily", candidateFromIssue(aiIssue));
  const financeCandidatePath = await writeCandidate(
    target,
    "finance-daily",
    candidateFromIssue(financeIssue),
  );

  await assert.rejects(
    () => processCandidate(target, "ai-daily", financeCandidatePath, { today: "2026-08-19" }),
    /Publication ai-daily/,
  );

  const aiLockDir = path.join(publicationDir(target, "ai-daily"), "data", ".locks");
  await mkdir(aiLockDir, { recursive: true });
  await writeFile(path.join(aiLockDir, "2026-08-19.lock"), "held\n", "utf8");
  await assert.rejects(
    () => processCandidate(target, "ai-daily", aiCandidatePath, { today: "2026-08-19" }),
    /已有写入流程/,
  );
  assert.equal(
    (await processCandidate(target, "finance-daily", financeCandidatePath, {
      today: "2026-08-19",
    })).result,
    "unchanged",
  );
});

test("共享主题库下的主题选择和 Active Manifest 按 Publication 隔离", async () => {
  const target = await fixture();
  const aiPublicationDir = publicationDir(target, "ai-daily");
  const financePublicationDir = publicationDir(target, "finance-daily");
  const financeConfigPath = path.join(financePublicationDir, "config", "theme.json");
  const financeActivePath = path.join(financePublicationDir, "themes", "active.json");
  const financeBefore = await Promise.all([
    readFile(financeConfigPath, "utf8"),
    readFile(financeActivePath, "utf8"),
  ]);

  const result = await switchTheme(target, "midnight-tech", {
    confirm: "midnight-tech",
    storageRoot: aiPublicationDir,
  });

  assert.deepEqual(
    { result: result.result, themeId: result.themeId, revision: result.revision },
    { result: "switched", themeId: "midnight-tech", revision: 1 },
  );
  assert.equal((await validateConfiguredTheme(target, aiPublicationDir)).themeId, "midnight-tech");
  assert.equal(
    (await validateConfiguredTheme(target, financePublicationDir)).themeId,
    "newspaper-default",
  );
  assert.deepEqual(
    await Promise.all([
      readFile(financeConfigPath, "utf8"),
      readFile(financeActivePath, "utf8"),
    ]),
    financeBefore,
  );
});

test("继承主题跟随 Home，显式切换转为 override，恢复继承必须确认", async () => {
  const target = await fixture();
  const aiPublicationDir = publicationDir(target, "ai-daily");
  const financePublicationDir = publicationDir(target, "finance-daily");
  await writeJson(path.join(aiPublicationDir, "config", "theme.json"), {
    schemaVersion: 2,
    mode: "inherit",
  });

  assert.equal((await validateConfiguredTheme(target, aiPublicationDir)).themeId, "newspaper-default");
  assert.equal((await validateConfiguredTheme(target, financePublicationDir)).themeId, "newspaper-default");
  await switchHomeTheme(target, "midnight-tech", {
    revision: 1,
    confirm: "midnight-tech",
  });
  assert.equal((await validateConfiguredTheme(target, aiPublicationDir)).themeId, "midnight-tech");
  assert.equal((await validateConfiguredTheme(target, financePublicationDir)).themeId, "newspaper-default");

  await switchTheme(target, "swiss-editorial", {
    confirm: "swiss-editorial",
    revision: 1,
    storageRoot: aiPublicationDir,
  });
  assert.deepEqual(await readJson(path.join(aiPublicationDir, "config", "theme.json")), {
    schemaVersion: 2,
    mode: "override",
    activeTheme: { id: "swiss-editorial", revision: 1 },
  });
  await switchHomeTheme(target, "newspaper-default", {
    revision: 1,
    confirm: "newspaper-default",
  });
  assert.equal((await validateConfiguredTheme(target, aiPublicationDir)).themeId, "swiss-editorial");

  await assert.rejects(
    () => inheritTheme(target, { storageRoot: aiPublicationDir }),
    /必须使用 --confirm/,
  );
  await inheritTheme(target, { confirm: true, storageRoot: aiPublicationDir });
  assert.deepEqual(await readJson(path.join(aiPublicationDir, "config", "theme.json")), {
    schemaVersion: 2,
    mode: "inherit",
  });
  assert.equal((await validateConfiguredTheme(target, aiPublicationDir)).themeId, "newspaper-default");
});

test("Theme Selection Schema 2 拒绝隐藏覆盖和不完整 override", async () => {
  const target = await fixture();
  const configPath = path.join(publicationDir(target, "ai-daily"), "config", "theme.json");
  await writeJson(configPath, {
    schemaVersion: 2,
    mode: "inherit",
    activeTheme: { id: "newspaper-default", revision: 1 },
  });
  await assert.rejects(
    () => validateConfiguredTheme(target, publicationDir(target, "ai-daily")),
    /activeTheme.*不是允许的配置字段/,
  );
  await writeJson(configPath, { schemaVersion: 2, mode: "override" });
  await assert.rejects(
    () => validateConfiguredTheme(target, publicationDir(target, "ai-daily")),
    /activeTheme.*不能为空/,
  );
});
