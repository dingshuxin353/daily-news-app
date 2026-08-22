import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { validateConfiguredTheme } from "./theme-pipeline.js";
import { validateSite } from "./validation.js";

const PUBLICATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REGISTRY_FIELDS = new Set([
  "schemaVersion",
  "defaultPublicationId",
  "publicationIds",
]);

export class PublicationError extends Error {
  constructor(field, message) {
    super(`${field} ${message}`);
    this.name = "PublicationError";
    this.field = field;
  }
}

function fail(field, message) {
  throw new PublicationError(field, message);
}

export function validatePublicationId(publicationId, field = "publicationId") {
  if (typeof publicationId !== "string" || !PUBLICATION_ID_PATTERN.test(publicationId)) {
    fail(field, "只能包含小写字母、数字和连字符");
  }
  return publicationId;
}

async function readRegistry(registryPath) {
  let source;
  try {
    source = await readFile(registryPath, "utf8");
  } catch (error) {
    fail("config/publications.json", `无法读取（${error.code ?? error.message}）`);
  }
  try {
    return JSON.parse(source);
  } catch {
    fail("config/publications.json", "不是合法 JSON");
  }
}

async function requireDirectory(directoryPath, field) {
  try {
    const resolvedPath = await realpath(directoryPath);
    if (
      !(await stat(directoryPath)).isDirectory()
      || resolvedPath !== path.resolve(directoryPath)
    ) {
      throw new Error();
    }
  } catch {
    fail(field, "目录不存在、不是普通目录或越过 Publication 边界");
  }
}

async function requireFile(filePath, field) {
  try {
    const resolvedPath = await realpath(filePath);
    if (!(await stat(filePath)).isFile() || resolvedPath !== path.resolve(filePath)) {
      throw new Error();
    }
  } catch {
    fail(field, "文件不存在、不是普通文件或越过 Publication 边界");
  }
}

function publicationContext(rootDir, publicationId, publicationDir) {
  return Object.freeze({
    rootDir,
    publicationId,
    publicationDir,
    configDir: path.join(publicationDir, "config"),
    dataDir: path.join(publicationDir, "data"),
    themeSelectionDir: path.join(publicationDir, "themes"),
  });
}

export async function loadPublicationRegistry(rootDir) {
  const resolvedRoot = await realpath(path.resolve(rootDir));
  const registryPath = path.join(resolvedRoot, "config", "publications.json");
  const registry = await readRegistry(registryPath);
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    fail("config/publications.json", "必须是对象");
  }
  for (const field of Object.keys(registry)) {
    if (!REGISTRY_FIELDS.has(field)) fail(`config/publications.json.${field}`, "不是允许的字段");
  }
  if (registry.schemaVersion !== 1) {
    fail("config/publications.json.schemaVersion", "必须等于 1");
  }
  if (!Array.isArray(registry.publicationIds) || registry.publicationIds.length === 0) {
    fail("config/publications.json.publicationIds", "必须是非空数组");
  }

  const seen = new Set();
  registry.publicationIds.forEach((publicationId, index) => {
    validatePublicationId(publicationId, `config/publications.json.publicationIds[${index}]`);
    if (seen.has(publicationId)) {
      fail(`config/publications.json.publicationIds[${index}]`, "不能重复");
    }
    seen.add(publicationId);
  });
  validatePublicationId(
    registry.defaultPublicationId,
    "config/publications.json.defaultPublicationId",
  );
  if (!seen.has(registry.defaultPublicationId)) {
    fail("config/publications.json.defaultPublicationId", "必须属于 publicationIds");
  }

  const publicationsRoot = path.join(resolvedRoot, "publications");
  await requireDirectory(publicationsRoot, "publications");
  const entries = await readdir(publicationsRoot, { withFileTypes: true });
  const visibleEntries = entries.filter(({ name }) => !name.startsWith("."));
  for (const entry of visibleEntries) {
    if (!entry.isDirectory() || !seen.has(entry.name)) {
      fail(`publications/${entry.name}`, "未在注册表中登记或不是普通目录");
    }
  }

  const contexts = [];
  for (const publicationId of registry.publicationIds) {
    const expectedDir = path.join(publicationsRoot, publicationId);
    let resolvedPublicationDir;
    try {
      resolvedPublicationDir = await realpath(expectedDir);
    } catch (error) {
      fail(`publications/${publicationId}`, `无法读取（${error.code ?? error.message}）`);
    }
    if (
      path.dirname(resolvedPublicationDir) !== publicationsRoot
      || path.basename(resolvedPublicationDir) !== publicationId
    ) {
      fail(`publications/${publicationId}`, "目录边界无效");
    }
    const context = publicationContext(resolvedRoot, publicationId, resolvedPublicationDir);
    for (const relativePath of [
      "config",
      "data",
      "data/candidates",
      "data/issues",
      "data/compiled",
      "data/submissions",
      "themes",
    ]) {
      await requireDirectory(
        path.join(resolvedPublicationDir, relativePath),
        `publications/${publicationId}/${relativePath}`,
      );
    }
    for (const relativePath of [
      "config/site.json",
      "config/theme.json",
      "themes/active.json",
    ]) {
      await requireFile(
        path.join(resolvedPublicationDir, relativePath),
        `publications/${publicationId}/${relativePath}`,
      );
    }
    await validateSite(resolvedRoot, resolvedPublicationDir);
    await validateConfiguredTheme(resolvedRoot, resolvedPublicationDir);
    contexts.push(context);
  }

  return Object.freeze({
    schemaVersion: 1,
    defaultPublicationId: registry.defaultPublicationId,
    publicationIds: Object.freeze([...registry.publicationIds]),
    publications: Object.freeze(contexts),
  });
}

export async function loadPublicationContext(rootDir, publicationId) {
  validatePublicationId(publicationId);
  const registry = await loadPublicationRegistry(rootDir);
  const context = registry.publications.find((entry) => entry.publicationId === publicationId);
  if (!context) fail("publicationId", `未注册：${publicationId}`);
  return context;
}
