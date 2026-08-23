import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { validateCompiled } from "./compiler.js";
import { loadPublicationRegistry, validatePublicationId } from "./publications.js";
import { validateConfiguredTheme } from "./theme-pipeline.js";
import { validateCandidate, validateSources } from "./validation.js";

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationError";
  }
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function jsonNames(directory) {
  return (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

async function themeRevisionCount(rootDir) {
  const definitionsRoot = path.join(rootDir, "themes", "definitions");
  const themeIds = (await readdir(definitionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  let revisions = 0;
  for (const themeId of themeIds) {
    revisions += (await readdir(path.join(definitionsRoot, themeId)))
      .filter((name) => name.endsWith(".json")).length;
  }
  return { themes: themeIds.length, revisions };
}

async function requireRegularTree(targetPath) {
  const metadata = await lstat(targetPath);
  if (metadata.isSymbolicLink()) throw new MigrationError(`${targetPath} 不能是符号链接`);
  if (metadata.isFile()) return;
  if (!metadata.isDirectory()) throw new MigrationError(`${targetPath} 不是普通文件或目录`);
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new MigrationError(`${entry.name} 不能是符号链接`);
    await requireRegularTree(path.join(targetPath, entry.name));
  }
}

async function validateMigratedPublication(rootDir, publicationDir) {
  const dataDir = path.join(publicationDir, "data");
  const candidateNames = await jsonNames(path.join(dataDir, "candidates"));
  for (const name of candidateNames) {
    await validateCandidate(path.join(dataDir, "candidates", name));
  }

  const { site, index, issues } = await validateSources(rootDir, publicationDir);
  const storedIndex = await json(path.join(dataDir, "index.json"));
  if (JSON.stringify(storedIndex) !== JSON.stringify(index)) {
    throw new MigrationError("data/index.json 与正式 Issue 日期集合不一致");
  }
  const compiledNames = await jsonNames(path.join(dataDir, "compiled"));
  const issueNames = issues.map(({ issue }) => `${issue.date}.json`).sort();
  if (JSON.stringify(compiledNames) !== JSON.stringify(issueNames)) {
    throw new MigrationError("Compiled 文件集合与正式 Issue 文件集合不一致");
  }
  for (const { issue } of issues) {
    const compiledPath = path.join(dataDir, "compiled", `${issue.date}.json`);
    validateCompiled(issue, await json(compiledPath), compiledPath, site.priorityLimits);
  }
  const activeTheme = await validateConfiguredTheme(rootDir, publicationDir);
  return {
    candidates: candidateNames.length,
    issues: issueNames.length,
    compiled: compiledNames.length,
    dates: index.dates,
    latest: index.latest,
    theme: { id: activeTheme.themeId, revision: activeTheme.revision },
  };
}

async function copyLegacyData(rootDir, stageDir) {
  for (const source of [
    "config/site.json",
    "config/theme.json",
    "themes/active.json",
    "data/candidates",
    "data/issues",
    "data/compiled",
    "data/index.json",
  ]) {
    await requireRegularTree(path.join(rootDir, source));
  }
  await mkdir(path.join(stageDir, "config"), { recursive: true });
  await mkdir(path.join(stageDir, "themes"), { recursive: true });
  await mkdir(path.join(stageDir, "data", "submissions"), { recursive: true });
  await cp(path.join(rootDir, "config", "site.json"), path.join(stageDir, "config", "site.json"));
  await cp(path.join(rootDir, "config", "theme.json"), path.join(stageDir, "config", "theme.json"));
  await cp(path.join(rootDir, "themes", "active.json"), path.join(stageDir, "themes", "active.json"));
  for (const directory of ["candidates", "issues", "compiled"]) {
    await cp(
      path.join(rootDir, "data", directory),
      path.join(stageDir, "data", directory),
      { recursive: true },
    );
  }
  await cp(path.join(rootDir, "data", "index.json"), path.join(stageDir, "data", "index.json"));
}

async function assertCopiesUnchanged(rootDir, stageDir) {
  const filePairs = [
    ["config/site.json", "config/site.json"],
    ["config/theme.json", "config/theme.json"],
    ["themes/active.json", "themes/active.json"],
    ["data/index.json", "data/index.json"],
  ];
  for (const directory of ["candidates", "issues", "compiled"]) {
    for (const name of await jsonNames(path.join(rootDir, "data", directory))) {
      filePairs.push([`data/${directory}/${name}`, `data/${directory}/${name}`]);
    }
  }
  for (const [source, target] of filePairs) {
    const [left, right] = await Promise.all([
      readFile(path.join(rootDir, source)),
      readFile(path.join(stageDir, target)),
    ]);
    if (!left.equals(right)) throw new MigrationError(`${source} 复制后内容不一致`);
  }
}

async function successfulPreviousMigration(rootDir, publicationId) {
  const registryPath = path.join(rootDir, "config", "publications.json");
  if (!await exists(registryPath)) return null;
  const registry = await loadPublicationRegistry(rootDir);
  if (
    registry.defaultPublicationId !== publicationId
    || registry.publicationIds.length !== 1
    || registry.publicationIds[0] !== publicationId
  ) {
    throw new MigrationError("Publication Registry 已存在，不能合并或覆盖现有多日报配置");
  }
  const context = registry.publications[0];
  return validateMigratedPublication(rootDir, context.publicationDir);
}

export async function migrateV09(rootDir, publicationId, confirmation) {
  validatePublicationId(publicationId);
  if (confirmation !== publicationId) {
    throw new MigrationError("--confirm 必须与 --publication 完全一致");
  }

  const previous = await successfulPreviousMigration(rootDir, publicationId);
  if (previous) {
    return {
      result: "unchanged",
      publicationId,
      pageUrl: `/p/${publicationId}/`,
      counts: previous,
      themeLibrary: await themeRevisionCount(rootDir),
    };
  }

  const publicationsRoot = path.join(rootDir, "publications");
  const targetDir = path.join(publicationsRoot, publicationId);
  if (await exists(targetDir)) {
    throw new MigrationError(`目标 Publication 已存在：${publicationId}`);
  }
  await mkdir(publicationsRoot, { recursive: true });
  const stageDir = path.join(publicationsRoot, `.${publicationId}.migration-${randomUUID()}`);
  let targetCreated = false;
  let temporaryRegistry = null;
  try {
    await copyLegacyData(rootDir, stageDir);
    await assertCopiesUnchanged(rootDir, stageDir);
    const counts = await validateMigratedPublication(rootDir, stageDir);
    const themeLibrary = await themeRevisionCount(rootDir);
    await rename(stageDir, targetDir);
    targetCreated = true;

    const registryPath = path.join(rootDir, "config", "publications.json");
    temporaryRegistry = path.join(
      path.dirname(registryPath),
      `.publications.json.${randomUUID()}.tmp`,
    );
    await writeFile(temporaryRegistry, `${JSON.stringify({
      schemaVersion: 1,
      defaultPublicationId: publicationId,
      publicationIds: [publicationId],
    }, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryRegistry, registryPath);
    return {
      result: "migrated",
      publicationId,
      pageUrl: `/p/${publicationId}/`,
      counts,
      themeLibrary,
      originalsPreserved: true,
    };
  } catch (error) {
    if (temporaryRegistry) await unlink(temporaryRegistry).catch(() => {});
    await rm(stageDir, { recursive: true, force: true });
    if (targetCreated) await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
}
