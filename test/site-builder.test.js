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
  for (const entry of ["index.html", "home.html", "styles.css", "src", "public", "themes"]) {
    await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
  }
  await mkdir(path.join(target, "config"), { recursive: true });
  await writeJson(path.join(target, "config", "publications.json"), {
    schemaVersion: 1,
    defaultPublicationId: "ai-daily",
    publicationIds: ["ai-daily", "finance-daily"],
  });
  const home = JSON.parse(await readFile(path.join(rootDir, "config", "home.json"), "utf8"));
  await writeJson(path.join(target, "config", "home.json"), { ...home, enabled: false });
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
  assert.match(financeHtml, /<a href="\/">总览<\/a>/);
  assert.match(financeHtml, /<a href="\/p\/finance-daily\/" aria-current="page">财经日报<\/a>/);
  assert.match(financeHtml, /<option value="\/">总览<\/option>/);
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

test("Home 开启时根路径生成总览、真实深链、目录和独立主题 Manifest", async () => {
  const target = await fixture();
  const homePath = path.join(target, "config", "home.json");
  const home = JSON.parse(await readFile(homePath, "utf8"));
  await writeJson(homePath, { ...home, enabled: true, name: "我的日报" });

  const { outputDir, overview } = await buildSite(target, undefined, { asOfDate: "2026-08-23" });
  const homeHtml = await readFile(path.join(outputDir, "index.html"), "utf8");
  const overviewOutput = JSON.parse(await readFile(
    path.join(outputDir, "home", "data", "overview.json"),
    "utf8",
  ));
  const active = JSON.parse(await readFile(
    path.join(outputDir, "home", "themes", "active.json"),
    "utf8",
  ));

  assert.equal(overview.asOfDate, "2026-08-23");
  assert.deepEqual(overviewOutput, overview);
  assert.equal(active.themeId, "newspaper-default");
  assert.match(homeHtml, /<h1>我的日报<\/h1>/);
  assert.match(homeHtml, /<a href="\/" aria-current="page">总览<\/a>/);
  assert.match(homeHtml, /<option value="\/" selected>总览<\/option>/);
  assert.match(homeHtml, /\/p\/ai-daily\/\?date=2026-08-19#test-item-1/);
  assert.ok(homeHtml.indexOf("AI 日报") < homeHtml.indexOf("财经日报"));
});

test("构建失败保留上一份正式 dist", async () => {
  const target = await fixture();
  const { outputDir } = await buildSite(target);
  const previous = await readFile(path.join(outputDir, "index.html"), "utf8");
  const homePath = path.join(target, "config", "home.json");
  const home = JSON.parse(await readFile(homePath, "utf8"));
  await writeJson(homePath, { ...home, accentColor: "invalid" });

  await assert.rejects(() => buildSite(target), /accentColor/);
  assert.equal(await readFile(path.join(outputDir, "index.html"), "utf8"), previous);
});
