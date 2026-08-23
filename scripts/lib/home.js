import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createThemeManifest } from "./theme-compiler.js";
import { loadStoredTheme } from "./theme-pipeline.js";

const HOME_FIELDS = new Set([
  "schemaVersion",
  "enabled",
  "name",
  "accentColor",
  "activeTheme",
]);
const ACTIVE_THEME_FIELDS = new Set(["id", "revision"]);
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class HomeError extends Error {
  constructor(field, message) {
    super(`${field} ${message}`);
    this.name = "HomeError";
    this.field = field;
  }
}

function fail(field, message) {
  throw new HomeError(field, message);
}

function requireExactFields(value, fields, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "必须是对象");
  }
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail(`${field}.${key}`, "不是允许的字段");
  }
  for (const key of fields) {
    if (!(key in value)) fail(`${field}.${key}`, "不能为空");
  }
}

async function readJson(filePath, field) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    fail(field, `无法读取（${error.code ?? error.message}）`);
  }
  try {
    return JSON.parse(source);
  } catch {
    fail(field, "不是合法 JSON");
  }
}

export async function validateHomeProfile(rootDir) {
  const filePath = path.join(rootDir, "config", "home.json");
  const home = await readJson(filePath, "config/home.json");
  requireExactFields(home, HOME_FIELDS, "config/home.json");
  if (home.schemaVersion !== 1) fail("config/home.json.schemaVersion", "必须等于 1");
  if (typeof home.enabled !== "boolean") fail("config/home.json.enabled", "必须是布尔值");
  if (typeof home.name !== "string" || home.name.trim() === "") {
    fail("config/home.json.name", "必须是非空字符串");
  }
  if (typeof home.accentColor !== "string" || !COLOR_PATTERN.test(home.accentColor)) {
    fail("config/home.json.accentColor", "必须是六位十六进制颜色");
  }
  requireExactFields(home.activeTheme, ACTIVE_THEME_FIELDS, "config/home.json.activeTheme");
  await loadStoredTheme(rootDir, home.activeTheme.id, home.activeTheme.revision);
  return home;
}

export async function resolveHomeTheme(rootDir, home) {
  const { definition, relativeCssPath } = await loadStoredTheme(
    rootDir,
    home.activeTheme.id,
    home.activeTheme.revision,
  );
  return createThemeManifest(definition, relativeCssPath, null);
}

export async function switchHomeTheme(rootDir, themeId, options = {}) {
  if (options.confirm !== themeId) fail("authorization", `必须使用 --confirm ${themeId} 明确确认切换`);
  const home = await validateHomeProfile(rootDir);
  const revisionNames = await readdir(path.join(rootDir, "themes", "definitions", themeId))
    .catch((error) => {
      if (error.code === "ENOENT") fail("theme", `Theme Revision 不存在：${themeId}`);
      throw error;
    });
  const revisions = revisionNames
    .filter((name) => /^[1-9]\d*\.json$/.test(name))
    .map((name) => Number(name.slice(0, -5)))
    .sort((left, right) => left - right);
  const targetRevision = options.revision ?? revisions.at(-1);
  const { definition } = await loadStoredTheme(rootDir, themeId, targetRevision);
  if (home.activeTheme.id === themeId && home.activeTheme.revision === targetRevision) {
    return { result: "unchanged", themeId, revision: targetRevision };
  }

  const lockPath = path.join(rootDir, "themes", ".theme.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
    await lock.writeFile(`${process.pid}\n`);
  } catch (error) {
    await lock?.close().catch(() => {});
    if (error.code === "EEXIST") fail("lock", "已有主题写入流程正在执行");
    throw error;
  }
  await lock.close();
  try {
    const next = {
      ...home,
      activeTheme: { id: definition.id, revision: definition.revision },
    };
    const homePath = path.join(rootDir, "config", "home.json");
    const temporaryPath = path.join(
      path.dirname(homePath),
      `.${path.basename(homePath)}.${randomUUID()}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, homePath);
    return { result: "switched", themeId, revision: targetRevision };
  } finally {
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function highlightProjection(publicationId, date, item) {
  return {
    itemId: item.id,
    ...(item.category === undefined ? {} : { category: item.category }),
    title: item.title,
    brief: item.brief,
    summary: item.summary,
    ...(item.image === undefined ? {} : { image: structuredClone(item.image) }),
    itemUrl: `/p/${publicationId}/?date=${date}#${item.id}`,
  };
}

export async function buildHomeOverview(rootDir, registry, options = {}) {
  const asOfDate = options.asOfDate ?? shanghaiDate();
  if (!DATE_PATTERN.test(asOfDate)) fail("asOfDate", "必须是 YYYY-MM-DD");

  const publications = [];
  for (const publication of registry.publications) {
    const site = await readJson(path.join(publication.configDir, "site.json"), `${publication.publicationId}.site`);
    const index = await readJson(path.join(publication.dataDir, "index.json"), `${publication.publicationId}.index`);
    const base = {
      id: publication.publicationId,
      name: site.name,
      latestDate: index.latest,
      sourceRevision: null,
      status: "empty",
      pageUrl: `/p/${publication.publicationId}/`,
      highlights: [],
    };
    if (index.latest === null) {
      publications.push(base);
      continue;
    }
    const issue = await readJson(
      path.join(publication.dataDir, "compiled", `${index.latest}.json`),
      `${publication.publicationId}.compiled.${index.latest}`,
    );
    publications.push({
      ...base,
      latestDate: index.latest,
      sourceRevision: issue.revision,
      status: index.latest === asOfDate ? "current" : "stale",
      highlights: issue.items.slice(0, 3).map((item) => (
        highlightProjection(publication.publicationId, index.latest, item)
      )),
    });
  }

  return {
    schemaVersion: 1,
    asOfDate,
    primaryPublicationId: registry.defaultPublicationId,
    publications,
  };
}
