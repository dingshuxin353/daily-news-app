import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  ContentValidationError,
  isValidContentDate,
  validateCandidateValue,
  validateIssueValue,
  validateSiteValue,
} from "./domain/content-validation.js";

export const ValidationError = ContentValidationError;
export { validateCandidateValue, validateIssueValue, validateSiteValue };

function fail(filePath, field, message) {
  throw new ValidationError(filePath, field, message);
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

async function inferRootDir(filePath) {
  let current = path.dirname(filePath);
  while (true) {
    try {
      if ((await stat(path.join(current, "public"))).isDirectory()) return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) fail(filePath, "$", "无法定位项目 public 目录");
    current = parent;
  }
}

function localAssetValidator(rootDir) {
  return async (value, filePath, field) => {
    if (!value || value.startsWith("https://")) return;
    const publicRoot = path.resolve(rootDir, "public");
    const resolvedPublicRoot = await realpath(publicRoot).catch(() => publicRoot);
    const assetPath = path.resolve(publicRoot, `.${value}`);
    if (!assetPath.startsWith(`${publicRoot}${path.sep}`)) fail(filePath, field, "不能指向 public 目录之外");
    try {
      const resolvedAsset = await realpath(assetPath);
      if (!(await stat(assetPath)).isFile() || !resolvedAsset.startsWith(`${resolvedPublicRoot}${path.sep}`)) {
        throw new Error();
      }
    } catch {
      fail(filePath, field, `对应的本地文件不存在或越过 public 边界（${value}）`);
    }
  };
}

export async function validateSite(rootDir, storageRoot = rootDir) {
  const filePath = path.join(storageRoot, "config", "site.json");
  return validateSiteValue(await readJson(filePath), {
    filePath,
    validateAsset: localAssetValidator(rootDir),
  });
}

export async function validateIssue(filePath, expectedDateOverride, rootDirOverride) {
  const fileName = path.basename(filePath);
  const expectedDate = expectedDateOverride ?? fileName.replace(/\.json$/, "");
  if (expectedDateOverride === undefined && (!/^\d{4}-\d{2}-\d{2}\.json$/.test(fileName) || !isValidContentDate(expectedDate))) {
    fail(filePath, "文件名", "必须是合法的 YYYY-MM-DD.json");
  }
  const rootDir = rootDirOverride ?? await inferRootDir(filePath);
  return validateIssueValue(await readJson(filePath), {
    filePath,
    expectedDate,
    validateAsset: localAssetValidator(rootDir),
  });
}

export async function validateCandidate(filePath, rootDirOverride) {
  const fileName = path.basename(filePath);
  const expectedDate = fileName.replace(/\.json$/, "");
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(fileName) || !isValidContentDate(expectedDate)) {
    fail(filePath, "文件名", "必须是合法的 YYYY-MM-DD.json");
  }
  const rootDir = rootDirOverride ?? await inferRootDir(filePath);
  return validateCandidateValue(await readJson(filePath), {
    filePath,
    expectedDate,
    validateAsset: localAssetValidator(rootDir),
  });
}

export async function validateSources(rootDir, storageRoot = rootDir) {
  const site = await validateSite(rootDir, storageRoot);
  const issuesDir = path.join(storageRoot, "data", "issues");
  let fileNames;
  try {
    fileNames = (await readdir(issuesDir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    fail(issuesDir, "$", `无法读取日报目录（${error.code ?? error.message}）`);
  }
  const issues = [];
  for (const fileName of fileNames) {
    const filePath = path.join(issuesDir, fileName);
    issues.push({ issue: await validateIssue(filePath, undefined, rootDir), filePath });
  }
  issues.sort((left, right) => right.issue.date.localeCompare(left.issue.date));
  const dates = issues.map(({ issue }) => issue.date);
  return { site, index: { latest: dates[0] ?? null, dates }, issues };
}

export async function validateAll(rootDir, storageRoot = rootDir) {
  return (await validateSources(rootDir, storageRoot)).index;
}
