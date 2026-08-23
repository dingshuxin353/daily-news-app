import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { migrateV09 } from "../scripts/lib/migration.js";
import { createTestIssue, seedTestData } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-migration-"));
  for (const entry of ["public", "themes"]) {
    await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
  }
  await mkdir(path.join(target, "config"), { recursive: true });
  await cp(path.join(rootDir, "config", "site.json"), path.join(target, "config", "site.json"));
  await cp(path.join(rootDir, "config", "theme.json"), path.join(target, "config", "theme.json"));
  await seedTestData(target);
  const candidate = structuredClone(createTestIssue("2026-08-20"));
  delete candidate.revision;
  await writeFile(
    path.join(target, "data", "candidates", "2026-08-20.json"),
    `${JSON.stringify(candidate, null, 2)}\n`,
  );
  return target;
}

async function legacySnapshot(target) {
  const paths = [
    "config/site.json",
    "config/theme.json",
    "themes/active.json",
    "data/index.json",
    "data/candidates/2026-08-20.json",
    "data/issues/2026-08-19.json",
    "data/issues/2026-08-18.json",
    "data/compiled/2026-08-19.json",
    "data/compiled/2026-08-18.json",
  ];
  return Promise.all(paths.map(async (filePath) => [
    filePath,
    await readFile(path.join(target, filePath), "utf8"),
  ]));
}

test("v0.9 迁移显式复制并核对内容、主题和数量，重复执行不复制第二份", async () => {
  const target = await fixture();
  const before = await legacySnapshot(target);

  const result = await migrateV09(target, "daily-news", "daily-news");
  assert.equal(result.result, "migrated");
  assert.equal(result.originalsPreserved, true);
  assert.equal(result.counts.candidates, 1);
  assert.equal(result.counts.issues, 2);
  assert.equal(result.counts.compiled, 2);
  assert.deepEqual(result.counts.dates, ["2026-08-19", "2026-08-18"]);
  assert.deepEqual(result.counts.theme, { id: "newspaper-default", revision: 1 });
  assert.deepEqual(result.themeLibrary, { themes: 3, revisions: 3 });

  for (const [filePath, source] of before) {
    assert.equal(await readFile(path.join(target, filePath), "utf8"), source);
  }
  const registry = JSON.parse(await readFile(path.join(target, "config", "publications.json")));
  assert.deepEqual(registry, {
    schemaVersion: 1,
    defaultPublicationId: "daily-news",
    publicationIds: ["daily-news"],
  });

  const repeated = await migrateV09(target, "daily-news", "daily-news");
  assert.equal(repeated.result, "unchanged");
  assert.deepEqual(
    (await readdir(path.join(target, "publications"))).filter((name) => !name.startsWith(".")),
    ["daily-news"],
  );
});

test("迁移要求 ID 二次确认，目标已存在时拒绝且不创建注册表", async () => {
  const target = await fixture();
  await assert.rejects(
    () => migrateV09(target, "daily-news", "wrong-id"),
    /--confirm 必须与 --publication 完全一致/,
  );
  await mkdir(path.join(target, "publications", "daily-news"), { recursive: true });
  await assert.rejects(
    () => migrateV09(target, "daily-news", "daily-news"),
    /目标 Publication 已存在/,
  );
  await assert.rejects(() => readFile(path.join(target, "config", "publications.json")), /ENOENT/);
});

test("迁移校验失败不激活注册表，并保留原始 v0.9 数据", async () => {
  const target = await fixture();
  const originalIssue = await readFile(path.join(target, "data", "issues", "2026-08-19.json"), "utf8");
  await writeFile(path.join(target, "data", "compiled", "2026-08-19.json"), "{ invalid");

  await assert.rejects(
    () => migrateV09(target, "daily-news", "daily-news"),
  );
  await assert.rejects(() => readFile(path.join(target, "config", "publications.json")), /ENOENT/);
  assert.equal(
    await readFile(path.join(target, "data", "issues", "2026-08-19.json"), "utf8"),
    originalIssue,
  );
  assert.deepEqual(await readdir(path.join(target, "publications")), []);
});
