import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRIORITIES = new Set(["lead", "important", "normal"]);

export class ValidationError extends Error {
  constructor(filePath, field, message) {
    super(`${filePath}: ${field} ${message}`);
    this.name = "ValidationError";
    this.filePath = filePath;
    this.field = field;
  }
}

function fail(filePath, field, message) {
  throw new ValidationError(filePath, field, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, filePath, field) {
  if (!isPlainObject(value)) fail(filePath, field, "必须是对象");
}

function requireString(value, filePath, field) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(filePath, field, "必须是非空字符串");
  }
}

function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function requireIsoTime(value, filePath, field) {
  if (
    typeof value !== "string"
    || !ISO_TIME_PATTERN.test(value)
    || !isValidDate(value.slice(0, 10))
    || Number.isNaN(Date.parse(value))
  ) {
    fail(filePath, field, "必须是合法 ISO 8601 时间");
  }
}

function requireHttpUrl(value, filePath, field) {
  requireString(value, filePath, field);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    fail(filePath, field, "必须是 http:// 或 https:// 地址");
  }
}

function requireAssetPath(value, filePath, field) {
  requireString(value, filePath, field);
  if (value.startsWith("https://")) return;
  if (!value.startsWith("/") || value.startsWith("//")) {
    fail(filePath, field, "必须是以 / 开头的本地路径或 https:// 地址");
  }
}

async function requireLocalAsset(rootDir, value, filePath, field) {
  if (!value || value.startsWith("https://")) return;
  const publicRoot = path.resolve(rootDir, "public");
  const assetPath = path.resolve(publicRoot, `.${value}`);
  if (!assetPath.startsWith(`${publicRoot}${path.sep}`)) {
    fail(filePath, field, "不能指向 public 目录之外");
  }
  try {
    if (!(await stat(assetPath)).isFile()) throw new Error();
  } catch {
    fail(filePath, field, `对应的本地文件不存在（${value}）`);
  }
}

async function readJson(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    fail(filePath, "$", `无法读取（${error.code ?? error.message}）`);
  }
  try {
    return JSON.parse(source);
  } catch {
    fail(filePath, "$", "不是合法 JSON");
  }
}

export async function validateSite(rootDir) {
  const filePath = path.join(rootDir, "config", "site.json");
  const site = await readJson(filePath);
  requireObject(site, filePath, "$");
  requireString(site.name, filePath, "name");
  if (typeof site.accentColor !== "string" || !COLOR_PATTERN.test(site.accentColor)) {
    fail(filePath, "accentColor", "必须是六位十六进制颜色");
  }
  if (site.logo !== undefined) {
    requireAssetPath(site.logo, filePath, "logo");
    await requireLocalAsset(rootDir, site.logo, filePath, "logo");
  }
  return site;
}

export async function validateIssue(filePath, expectedDateOverride) {
  const fileName = path.basename(filePath);
  const expectedDate = expectedDateOverride ?? fileName.replace(/\.json$/, "");
  if (expectedDateOverride !== undefined && !isValidDate(expectedDateOverride)) {
    fail(filePath, "目标日期", "必须是合法的 YYYY-MM-DD");
  }
  if (expectedDateOverride === undefined && (!/^\d{4}-\d{2}-\d{2}\.json$/.test(fileName) || !isValidDate(expectedDate))) {
    fail(filePath, "文件名", "必须是合法的 YYYY-MM-DD.json");
  }

  const issue = await readJson(filePath);
  requireObject(issue, filePath, "$");
  if (issue.schemaVersion !== 1) fail(filePath, "schemaVersion", "必须等于 1");
  if (issue.date !== expectedDate) fail(filePath, "date", "必须与文件名一致");
  requireIsoTime(issue.generatedAt, filePath, "generatedAt");
  if (!Array.isArray(issue.items) || issue.items.length === 0) {
    fail(filePath, "items", "必须是非空数组");
  }

  const ids = new Set();
  for (const [index, item] of issue.items.entries()) {
    const field = `items[${index}]`;
    requireObject(item, filePath, field);
    requireString(item.id, filePath, `${field}.id`);
    if (!ITEM_ID_PATTERN.test(item.id)) {
      fail(filePath, `${field}.id`, "只能包含小写字母、数字和连字符，且不能以连字符开头或结尾");
    }
    if (ids.has(item.id)) fail(filePath, `${field}.id`, `内容 ${item.id} 在同一期日报内不能重复`);
    ids.add(item.id);
    requireString(item.title, filePath, `${field}.title`);
    requireString(item.brief, filePath, `${field}.brief（内容 ${item.id}）`);
    requireString(item.summary, filePath, `${field}.summary`);
    requireObject(item.editorial, filePath, `${field}.editorial（内容 ${item.id}）`);
    requireString(item.editorial.priority, filePath, `${field}.editorial.priority（内容 ${item.id}）`);
    if (!PRIORITIES.has(item.editorial.priority)) {
      fail(filePath, `${field}.editorial.priority（内容 ${item.id}）`, "只能是 lead、important 或 normal");
    }
    requireString(item.editorial.selectionReason, filePath, `${field}.editorial.selectionReason（内容 ${item.id}）`);
    if (item.category !== undefined) requireString(item.category, filePath, `${field}.category`);
    if (item.score !== undefined || item.selected !== undefined) {
      fail(filePath, `${field}（内容 ${item.id}）`, "不能包含 AIHot 的 score 或 selected 字段");
    }
    if (!Array.isArray(item.sources) || item.sources.length === 0) {
      fail(filePath, `${field}.sources（内容 ${item.id}）`, "必须是非空数组");
    }

    const sourceUrls = new Set();
    for (const [sourceIndex, source] of item.sources.entries()) {
      const sourceField = `${field}.sources[${sourceIndex}]`;
      requireObject(source, filePath, `${sourceField}（内容 ${item.id}）`);
      requireString(source.name, filePath, `${sourceField}.name（内容 ${item.id}）`);
      requireHttpUrl(source.url, filePath, `${sourceField}.url（内容 ${item.id}）`);
      if (sourceUrls.has(source.url)) {
        fail(filePath, `${sourceField}.url（内容 ${item.id}）`, "同一条内容内不能重复");
      }
      sourceUrls.add(source.url);
      if (source.originalTitle !== undefined) {
        requireString(source.originalTitle, filePath, `${sourceField}.originalTitle（内容 ${item.id}）`);
      }
      for (const timeField of ["publishedAt", "discoveredAt"]) {
        if (source[timeField] !== undefined) {
          requireIsoTime(source[timeField], filePath, `${sourceField}.${timeField}（内容 ${item.id}）`);
        }
      }
      if (source.via !== undefined) {
        requireObject(source.via, filePath, `${sourceField}.via（内容 ${item.id}）`);
        requireString(source.via.name, filePath, `${sourceField}.via.name（内容 ${item.id}）`);
        requireHttpUrl(source.via.url, filePath, `${sourceField}.via.url（内容 ${item.id}）`);
      }
    }
  }
  return issue;
}

export async function validateSources(rootDir) {
  await validateSite(rootDir);
  const issuesDir = path.join(rootDir, "data", "issues");
  let fileNames;
  try {
    fileNames = (await readdir(issuesDir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    fail(issuesDir, "$", `无法读取日报目录（${error.code ?? error.message}）`);
  }
  if (fileNames.length === 0) fail(issuesDir, "$", "至少需要一份日报 JSON");

  const issues = [];
  for (const fileName of fileNames) {
    const filePath = path.join(issuesDir, fileName);
    issues.push({ issue: await validateIssue(filePath), filePath });
  }
  issues.sort((a, b) => b.issue.date.localeCompare(a.issue.date));
  const dates = issues.map(({ issue }) => issue.date);
  return {
    index: { latest: dates[0], dates },
    issues,
  };
}

export async function validateAll(rootDir) {
  return (await validateSources(rootDir)).index;
}
