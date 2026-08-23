import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSite } from "../scripts/lib/site-builder.js";
import { switchTheme } from "../scripts/lib/theme-pipeline.js";
import { createTestIssue, seedTestData } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createPublication(target, publicationId, name) {
  const publication = path.join(target, "publications", publicationId);
  await mkdir(path.join(publication, "config"), { recursive: true });
  await mkdir(path.join(publication, "themes"), { recursive: true });
  await mkdir(path.join(publication, "data", "submissions"), { recursive: true });
  const site = JSON.parse(await readFile(path.join(rootDir, "config", "site.json")));
  site.name = name;
  await writeJson(path.join(publication, "config", "site.json"), site);
  await cp(path.join(rootDir, "config", "theme.json"), path.join(publication, "config", "theme.json"));
  await cp(path.join(rootDir, "themes", "active.json"), path.join(publication, "themes", "active.json"));
  await seedTestData(publication);
  const candidate = structuredClone(createTestIssue("2026-08-20"));
  delete candidate.revision;
  await writeJson(path.join(publication, "data", "candidates", "2026-08-20.json"), candidate);
  return publication;
}

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-build-"));
  for (const entry of ["index.html", "styles.css", "src", "public", "themes"]) {
    await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
  }
  await mkdir(path.join(target, "config"), { recursive: true });
  await writeJson(path.join(target, "config", "publications.json"), {
    schemaVersion: 1,
    defaultPublicationId: "ai-daily",
    publicationIds: ["ai-daily", "finance-daily"],
  });
  await createPublication(target, "ai-daily", "AI 日报");
  const finance = await createPublication(target, "finance-daily", "财经日报");
  await switchTheme(target, "midnight-tech", {
    confirm: "midnight-tech",
    revision: 1,
    storageRoot: finance,
  });
  return target;
}

test("构建为每个 Publication 生成独立入口、数据和首帧主题，根路径进入默认项", async () => {
  const target = await fixture();
  const { outputDir } = await buildSite(target);
  const rootHtml = await readFile(path.join(outputDir, "index.html"), "utf8");
  const aiHtml = await readFile(path.join(outputDir, "p", "ai-daily", "index.html"), "utf8");
  const financeHtml = await readFile(path.join(outputDir, "p", "finance-daily", "index.html"), "utf8");

  assert.match(rootHtml, /location\.replace\("\/p\/ai-daily\/"\)/);
  assert.match(aiHtml, /<span class="brand__name">AI 日报<\/span>/);
  assert.match(aiHtml, /data-theme="newspaper-default"/);
  assert.match(financeHtml, /<span class="brand__name">财经日报<\/span>/);
  assert.match(financeHtml, /data-theme="midnight-tech"/);
  assert.match(financeHtml, /<option value="\/p\/ai-daily\/">AI 日报<\/option>/);
  assert.match(financeHtml, /<option value="\/p\/finance-daily\/" selected>财经日报<\/option>/);
  assert.match(financeHtml, /2026-08-19 最新一期来源清单/);

  const aiIssue = JSON.parse(await readFile(
    path.join(outputDir, "p", "ai-daily", "data", "compiled", "2026-08-19.json"),
  ));
  const financeIssue = JSON.parse(await readFile(
    path.join(outputDir, "p", "finance-daily", "data", "compiled", "2026-08-19.json"),
  ));
  assert.deepEqual(aiIssue.items, financeIssue.items);
  await assert.rejects(
    () => stat(path.join(outputDir, "p", "ai-daily", "data", "candidates", "2026-08-20.json")),
    /ENOENT/,
  );
});
