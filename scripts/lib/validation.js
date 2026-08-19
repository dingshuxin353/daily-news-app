import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

export async function validateIssue(rootDir, filePath) {
  const fileName = path.basename(filePath);
  const expectedDate = fileName.replace(/\.json$/, "");
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(fileName) || !isValidDate(expectedDate)) {
    fail(filePath, "文件名", "必须是合法的 YYYY-MM-DD.json");
  }

  const issue = await readJson(filePath);
  requireObject(issue, filePath, "$");
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
    if (ids.has(item.id)) fail(filePath, `${field}.id`, "在同一期日报内不能重复");
    ids.add(item.id);
    requireString(item.title, filePath, `${field}.title`);
    requireString(item.summary, filePath, `${field}.summary`);
    if (item.category !== undefined) requireString(item.category, filePath, `${field}.category`);
    if (item.image !== undefined) {
      requireAssetPath(item.image, filePath, `${field}.image`);
      await requireLocalAsset(rootDir, item.image, filePath, `${field}.image`);
    }
    requireObject(item.source, filePath, `${field}.source`);
    requireString(item.source.name, filePath, `${field}.source.name`);
    requireHttpUrl(item.source.url, filePath, `${field}.source.url`);
    if (item.source.publishedAt !== undefined) {
      requireIsoTime(item.source.publishedAt, filePath, `${field}.source.publishedAt`);
    }
  }
  return issue;
}

export async function validateAll(rootDir) {
  await validateSite(rootDir);
  const issuesDir = path.join(rootDir, "data", "issues");
  let fileNames;
  try {
    fileNames = (await readdir(issuesDir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    fail(issuesDir, "$", `无法读取日报目录（${error.code ?? error.message}）`);
  }
  if (fileNames.length === 0) fail(issuesDir, "$", "至少需要一份日报 JSON");

  const dates = [];
  for (const fileName of fileNames) {
    const issue = await validateIssue(rootDir, path.join(issuesDir, fileName));
    dates.push(issue.date);
  }
  dates.sort((a, b) => b.localeCompare(a));
  return { latest: dates[0], dates };
}
