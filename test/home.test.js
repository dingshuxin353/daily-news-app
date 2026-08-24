import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHomeOverview,
  resolveHomeTheme,
  validateHomeProfile,
} from "../scripts/lib/home.js";
import { loadPublicationRegistry } from "../scripts/lib/publications.js";
import { createTestIssue, seedTestData } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createPublication(target, id, name) {
  const publication = path.join(target, "publications", id);
  await mkdir(path.join(publication, "config"), { recursive: true });
  await mkdir(path.join(publication, "themes"), { recursive: true });
  await mkdir(path.join(publication, "data", "submissions"), { recursive: true });
  const site = JSON.parse(await readFile(path.join(rootDir, "config", "site.json"), "utf8"));
  await writeJson(path.join(publication, "config", "site.json"), { ...site, name });
  await cp(path.join(rootDir, "config", "theme.json"), path.join(publication, "config", "theme.json"));
  await cp(path.join(rootDir, "themes", "active.json"), path.join(publication, "themes", "active.json"));
  await seedTestData(publication);
  return publication;
}

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-home-"));
  await cp(path.join(rootDir, "themes"), path.join(target, "themes"), { recursive: true });
  await cp(path.join(rootDir, "public"), path.join(target, "public"), { recursive: true });
  await mkdir(path.join(target, "config"), { recursive: true });
  const ids = ["ai-daily", "finance-daily", "local-daily"];
  await writeJson(path.join(target, "config", "publications.json"), {
    schemaVersion: 1,
    defaultPublicationId: "finance-daily",
    publicationIds: ids,
  });
  await writeJson(path.join(target, "config", "home.json"), {
    schemaVersion: 1,
    enabled: true,
    name: "我的日报",
    accentColor: "#B37721",
    activeTheme: { id: "newspaper-default", revision: 1 },
  });
  const ai = await createPublication(target, "ai-daily", "AI 日报");
  const finance = await createPublication(target, "finance-daily", "财经日报");
  const local = await createPublication(target, "local-daily", "本地日报");

  const current = createTestIssue("2026-08-23", ["lead", "important", "normal", "normal"]);
  await writeJson(path.join(finance, "data", "compiled", "2026-08-23.json"), current);
  await writeJson(path.join(finance, "data", "issues", "2026-08-23.json"), current);
  await writeJson(path.join(finance, "data", "index.json"), {
    latest: "2026-08-23",
    dates: ["2026-08-23", "2026-08-19", "2026-08-18"],
  });
  await writeJson(path.join(local, "data", "index.json"), { latest: null, dates: [] });
  return { target, ai, finance, local };
}

test("Home Profile 严格校验并解析已保存主题", async () => {
  const { target } = await fixture();
  const home = await validateHomeProfile(target);
  const active = await resolveHomeTheme(target, home);
  assert.equal(home.name, "我的日报");
  assert.equal(active.themeId, "newspaper-default");
  assert.equal(active.revision, 1);

  const invalidCases = [
    [{ extra: true }, /extra.*不是允许的字段/],
    [{ accentColor: "gold" }, /accentColor.*六位十六进制颜色/],
    [{ activeTheme: { id: "missing", revision: 1 } }, /Theme Revision 不存在/],
    [{ activeTheme: { id: "newspaper-default", revision: 0 } }, /revision.*大于等于 1/],
  ];
  for (const [change, pattern] of invalidCases) {
    const valid = {
      schemaVersion: 1,
      enabled: true,
      name: "我的日报",
      accentColor: "#B37721",
      activeTheme: { id: "newspaper-default", revision: 1 },
    };
    await writeJson(path.join(target, "config", "home.json"), { ...valid, ...change });
    await assert.rejects(() => validateHomeProfile(target), pattern);
  }
});

test("Overview 按 Registry 隔离聚合 current、stale、empty 且每份最多三条", async () => {
  const { target } = await fixture();
  const registry = await loadPublicationRegistry(target);
  const overview = await buildHomeOverview(target, registry, { asOfDate: "2026-08-23" });

  assert.equal(overview.primaryPublicationId, "finance-daily");
  assert.deepEqual(overview.publications.map(({ id }) => id), [
    "ai-daily",
    "finance-daily",
    "local-daily",
  ]);
  assert.deepEqual(overview.publications.map(({ status }) => status), ["stale", "current", "empty"]);
  assert.equal(overview.publications[0].highlights.length, 3);
  assert.equal(overview.publications[1].highlights.length, 3);
  assert.equal(overview.publications[2].highlights.length, 0);
  assert.equal(
    overview.publications[1].highlights[0].itemUrl,
    "/p/finance-daily/?date=2026-08-23#test-item-1",
  );
  assert.equal(overview.publications[0].highlights[0].itemId, "test-item-1");
  assert.equal(overview.publications[1].highlights[0].itemId, "test-item-1");
  assert.equal("sources" in overview.publications[0].highlights[0], false);
  assert.equal("coverage" in overview, false);
});
