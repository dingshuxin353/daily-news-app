import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  compileThemeCss,
  contentHash,
  createThemeDefinition,
  createThemeManifest,
  stableJson,
} from "./theme-compiler.js";
import {
  SUPPORTED_THEME_COMPILER_VERSIONS,
  THEME_COMPILER_VERSION,
  resolveThemeCandidate,
} from "./theme-validation.js";

export class ThemePipelineError extends Error {
  constructor(field, message) {
    super(`${field} ${message}`);
    this.name = "ThemePipelineError";
    this.field = field;
  }
}

const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new ThemePipelineError(filePath, "不是合法 JSON");
  }
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactFields(value, fields, field) {
  if (!isObject(value)) throw new ThemePipelineError(field, "必须是对象");
  const expected = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new ThemePipelineError(`${field}.${key}`, "不是允许的配置字段");
  }
  for (const key of fields) {
    if (!(key in value)) throw new ThemePipelineError(`${field}.${key}`, "不能为空");
  }
}

function themeConfig(themeId, revision) {
  return {
    schemaVersion: 2,
    mode: "override",
    activeTheme: { id: themeId, revision },
  };
}

function themeConfigSource(themeId, revision) {
  return `${JSON.stringify(themeConfig(themeId, revision), null, 2)}\n`;
}

async function writeAtomic(filePath, source) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, source, { flag: "wx" });
  await rename(temporaryPath, filePath);
}

export async function stageFile(filePath, source) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const previous = await readFile(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  await writeFile(temporaryPath, source, { flag: "wx" });
  return { filePath, temporaryPath, previous };
}

async function restoreStage(stage) {
  if (stage.previous === null) {
    await unlink(stage.filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  const temporaryPath = `${stage.filePath}.${randomUUID()}.restore`;
  await writeFile(temporaryPath, stage.previous, { flag: "wx" });
  await rename(temporaryPath, stage.filePath);
}

export async function commitStages(stages) {
  const committed = [];
  try {
    for (const stage of stages) {
      await rename(stage.temporaryPath, stage.filePath);
      committed.push(stage);
    }
  } catch (error) {
    const failures = [];
    for (const stage of committed.reverse()) {
      try {
        await restoreStage(stage);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length > 0) throw new AggregateError([error, ...failures], "主题事务失败且回滚不完整");
    throw error;
  } finally {
    await Promise.all(stages.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
  }
}

export async function acquireLock(rootDir) {
  const lockPath = path.join(rootDir, "themes", ".theme.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "EEXIST") throw new ThemePipelineError("lock", "已有主题写入流程正在执行");
    throw error;
  }
  await handle.close();
  return () => unlink(lockPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function inputHashes(candidate, resolved, usesSiteAccent) {
  return {
    candidateHash: contentHash(candidate),
    inputHash: contentHash({ candidate, resolved, usesSiteAccent }),
  };
}

export async function processTheme(rootDir, candidatePath) {
  const { candidate, resolved, usesSiteAccent } = await resolveThemeCandidate(rootDir, candidatePath);
  const { candidateHash, inputHash } = inputHashes(candidate, resolved, usesSiteAccent);
  const definition = createThemeDefinition(resolved, 0, { usesSiteAccent });
  const cssPath = `/themes/previews/${candidate.id}.css`;
  const css = compileThemeCss(resolved, 0, { usesSiteAccent });
  const manifest = {
    ...createThemeManifest(definition, cssPath, candidateHash),
    status: "preview-ready",
    inputHash,
    definition,
  };
  const previewDir = path.join(rootDir, "themes", "previews");
  const manifestPath = path.join(previewDir, `${candidate.id}.json`);
  const compiledPath = path.join(previewDir, `${candidate.id}.css`);
  const previous = await readJson(manifestPath);
  const unchanged = previous?.inputHash === inputHash
    && previous?.compilerVersion === THEME_COMPILER_VERSION
    && await fileExists(compiledPath)
    && contentHash(await readFile(compiledPath, "utf8")) === contentHash(css);
  if (unchanged) return { result: "unchanged", themeId: candidate.id, candidateHash, preview: manifestPath };

  await writeAtomic(compiledPath, css);
  await writeAtomic(manifestPath, stableJson(manifest));
  return { result: "preview-ready", themeId: candidate.id, candidateHash, preview: manifestPath };
}

async function nextRevision(rootDir, themeId) {
  const revisions = await storedRevisions(rootDir, themeId);
  return revisions.length === 0 ? 1 : revisions.at(-1) + 1;
}

async function storedRevisions(rootDir, themeId) {
  if (!THEME_ID_PATTERN.test(themeId)) {
    throw new ThemePipelineError("themeId", "只能包含小写字母、数字和连字符");
  }
  const definitionDir = path.join(rootDir, "themes", "definitions", themeId);
  const names = await readdir(definitionDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names
    .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((revision) => Number.isInteger(revision) && revision >= 1)
    .sort((first, second) => first - second);
}

export async function loadStoredTheme(rootDir, themeId, revision) {
  if (!THEME_ID_PATTERN.test(themeId)) {
    throw new ThemePipelineError("themeId", "只能包含小写字母、数字和连字符");
  }
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ThemePipelineError("revision", "必须是大于等于 1 的整数");
  }
  const definitionPath = path.join(rootDir, "themes", "definitions", themeId, `${revision}.json`);
  const compiledPath = path.join(rootDir, "themes", "compiled", themeId, `${revision}.css`);
  const definition = await readJson(definitionPath);
  if (!definition || !await fileExists(compiledPath)) {
    throw new ThemePipelineError("theme", `Theme Revision 不存在：${themeId}@${revision}`);
  }
  if (
    definition.schemaVersion !== 1
    || definition.id !== themeId
    || definition.revision !== revision
    || !SUPPORTED_THEME_COMPILER_VERSIONS.has(definition.compilerVersion)
  ) {
    throw new ThemePipelineError("theme", `Theme Revision 元数据无效：${themeId}@${revision}`);
  }
  const compiled = await readFile(compiledPath, "utf8");
  const header = `schemaVersion=${definition.schemaVersion} | id=${themeId} | revision=${revision} | compiler=${definition.compilerVersion}`;
  if (!compiled.startsWith(`/* DailyNews Theme | ${header}`)) {
    throw new ThemePipelineError("theme", `Theme Revision 编译产物无效：${themeId}@${revision}`);
  }
  return {
    definition,
    relativeCssPath: `/themes/compiled/${themeId}/${revision}.css`,
  };
}

async function validateThemeConfig(rootDir, storageRoot = rootDir) {
  const configPath = path.join(storageRoot, "config", "theme.json");
  const config = await readJson(configPath);
  if (!config) throw new ThemePipelineError("config/theme.json", "不存在");
  if (config.schemaVersion === 1) {
    requireExactFields(config, ["schemaVersion", "activeTheme"], "config/theme.json");
    requireExactFields(config.activeTheme, ["id", "revision"], "config/theme.json.activeTheme");
    const { id, revision } = config.activeTheme;
    await loadStoredTheme(rootDir, id, revision);
    return { config, activeTheme: config.activeTheme, inherited: false, legacy: true };
  }
  if (config.schemaVersion !== 2) {
    throw new ThemePipelineError("config/theme.json.schemaVersion", "必须等于 2");
  }
  if (config.mode === "inherit") {
    requireExactFields(config, ["schemaVersion", "mode"], "config/theme.json");
    const homePath = path.join(rootDir, "config", "home.json");
    const home = await readJson(homePath);
    if (!home?.activeTheme) {
      throw new ThemePipelineError("config/home.json.activeTheme", "不存在，无法继承主页主题");
    }
    requireExactFields(home.activeTheme, ["id", "revision"], "config/home.json.activeTheme");
    await loadStoredTheme(rootDir, home.activeTheme.id, home.activeTheme.revision);
    return { config, activeTheme: home.activeTheme, inherited: true, legacy: false };
  }
  if (config.mode !== "override") {
    throw new ThemePipelineError("config/theme.json.mode", "只能是 inherit 或 override");
  }
  requireExactFields(config, ["schemaVersion", "mode", "activeTheme"], "config/theme.json");
  requireExactFields(config.activeTheme, ["id", "revision"], "config/theme.json.activeTheme");
  const { id, revision } = config.activeTheme;
  await loadStoredTheme(rootDir, id, revision);
  return { config, activeTheme: config.activeTheme, inherited: false, legacy: false };
}

function semanticDefinition(definition) {
  if (!definition) return null;
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    usesSiteAccent: definition.usesSiteAccent,
    tokens: definition.tokens,
    recipes: definition.recipes,
  };
}

export async function activateTheme(rootDir, themeId, options = {}) {
  if (options.confirm !== themeId) {
    throw new ThemePipelineError("authorization", `必须使用 --confirm ${themeId} 明确确认激活`);
  }
  const candidatePath = path.join(rootDir, "themes", "candidates", `${themeId}.json`);
  const { candidate, resolved, usesSiteAccent } = await resolveThemeCandidate(rootDir, candidatePath);
  const { candidateHash, inputHash } = inputHashes(candidate, resolved, usesSiteAccent);
  const previewPath = path.join(rootDir, "themes", "previews", `${themeId}.json`);
  const preview = await readJson(previewPath);
  if (
    !preview
    || preview.candidateHash !== candidateHash
    || preview.inputHash !== inputHash
    || preview.compilerVersion !== THEME_COMPILER_VERSION
  ) {
    throw new ThemePipelineError("preview", "预览不存在、已过期或与当前候选不一致，请重新运行 process-theme");
  }

  const releaseLock = await acquireLock(rootDir);
  try {
    const storageRoot = options.storageRoot ?? rootDir;
    const activePath = path.join(storageRoot, "themes", "active.json");
    const active = await validateConfiguredTheme(rootDir, storageRoot);
    const activeDefinitionPath = active
      ? path.join(rootDir, "themes", "definitions", active.themeId, `${active.revision}.json`)
      : null;
    const activeDefinition = activeDefinitionPath ? await readJson(activeDefinitionPath) : null;
    const planned = createThemeDefinition(resolved, 0, { usesSiteAccent });
    if (
      active?.themeId === themeId
      && contentHash(semanticDefinition(activeDefinition)) === contentHash(semanticDefinition(planned))
    ) {
      return { result: "unchanged", themeId, revision: active.revision };
    }

    const revision = await nextRevision(rootDir, themeId);
    const definition = createThemeDefinition(resolved, revision, { usesSiteAccent });
    const relativeCssPath = `/themes/compiled/${themeId}/${revision}.css`;
    const css = compileThemeCss(resolved, revision, { usesSiteAccent });
    const definitionPath = path.join(rootDir, "themes", "definitions", themeId, `${revision}.json`);
    const compiledPath = path.join(rootDir, "themes", "compiled", themeId, `${revision}.css`);
    const configPath = path.join(storageRoot, "config", "theme.json");
    const nextActive = {
      ...createThemeManifest(definition, relativeCssPath, candidateHash),
      previous: active ? { themeId: active.themeId, revision: active.revision } : null,
    };
    const stages = [
      await stageFile(definitionPath, stableJson(definition)),
      await stageFile(compiledPath, css),
      await stageFile(configPath, themeConfigSource(themeId, revision)),
      await stageFile(activePath, stableJson(nextActive)),
    ];
    await commitStages(stages);
    return { result: "activated", themeId, revision, previous: nextActive.previous };
  } finally {
    await releaseLock();
  }
}

export async function listThemes(rootDir, storageRoot = rootDir) {
  const active = await validateConfiguredTheme(rootDir, storageRoot);
  const definitionsDir = path.join(rootDir, "themes", "definitions");
  const entries = await readdir(definitionsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const themes = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const revisions = await storedRevisions(rootDir, entry.name);
    if (revisions.length === 0) continue;
    const latestRevision = revisions.at(-1);
    const { definition } = await loadStoredTheme(rootDir, entry.name, latestRevision);
    for (const revision of revisions.slice(0, -1)) {
      await loadStoredTheme(rootDir, entry.name, revision);
    }
    themes.push({
      id: definition.id,
      name: definition.name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      latestRevision,
      revisions,
      activeRevision: active.themeId === definition.id ? active.revision : null,
    });
  }
  return {
    activeTheme: { id: active.themeId, revision: active.revision },
    themes,
  };
}

export async function switchTheme(rootDir, themeId, options = {}) {
  if (options.confirm !== themeId) {
    throw new ThemePipelineError("authorization", `必须使用 --confirm ${themeId} 明确确认切换`);
  }
  const releaseLock = await acquireLock(rootDir);
  try {
    const storageRoot = options.storageRoot ?? rootDir;
    const active = await validateConfiguredTheme(rootDir, storageRoot);
    const revisions = await storedRevisions(rootDir, themeId);
    const revision = options.revision ?? revisions.at(-1);
    if (revision === undefined) {
      throw new ThemePipelineError("theme", `Theme Revision 不存在：${themeId}`);
    }
    const { definition, relativeCssPath } = await loadStoredTheme(rootDir, themeId, revision);
    if (active.themeId === themeId && active.revision === revision) {
      return { result: "unchanged", themeId, revision };
    }
    const nextActive = {
      ...createThemeManifest(definition, relativeCssPath, null),
      previous: { themeId: active.themeId, revision: active.revision },
    };
    const stages = [
      await stageFile(path.join(storageRoot, "config", "theme.json"), themeConfigSource(themeId, revision)),
      await stageFile(path.join(storageRoot, "themes", "active.json"), stableJson(nextActive)),
    ];
    await commitStages(stages);
    return {
      result: "switched",
      themeId,
      revision,
      previous: nextActive.previous,
    };
  } finally {
    await releaseLock();
  }
}

export async function inheritTheme(rootDir, options = {}) {
  if (options.confirm !== true) {
    throw new ThemePipelineError("authorization", "必须使用 --confirm 明确确认恢复继承");
  }
  const storageRoot = options.storageRoot;
  if (!storageRoot || path.resolve(storageRoot) === path.resolve(rootDir)) {
    throw new ThemePipelineError("storageRoot", "恢复继承只适用于明确的 Publication");
  }
  const releaseLock = await acquireLock(rootDir);
  try {
    const configPath = path.join(storageRoot, "config", "theme.json");
    const current = await readJson(configPath);
    if (current?.schemaVersion === 2 && current.mode === "inherit") {
      await validateConfiguredTheme(rootDir, storageRoot);
      return { result: "unchanged", mode: "inherit" };
    }
    const home = await readJson(path.join(rootDir, "config", "home.json"));
    if (!home?.activeTheme) {
      throw new ThemePipelineError("config/home.json.activeTheme", "不存在，无法恢复继承");
    }
    const { definition, relativeCssPath } = await loadStoredTheme(
      rootDir,
      home.activeTheme.id,
      home.activeTheme.revision,
    );
    const manifest = createThemeManifest(definition, relativeCssPath, null);
    const stages = [
      await stageFile(
        configPath,
        `${JSON.stringify({ schemaVersion: 2, mode: "inherit" }, null, 2)}\n`,
      ),
      await stageFile(
        path.join(storageRoot, "themes", "active.json"),
        stableJson(manifest),
      ),
    ];
    await commitStages(stages);
    return {
      result: "inherited",
      mode: "inherit",
      themeId: manifest.themeId,
      revision: manifest.revision,
    };
  } finally {
    await releaseLock();
  }
}

export async function rollbackTheme(rootDir, options = {}) {
  if (options.confirm !== true) {
    throw new ThemePipelineError("authorization", "必须使用 --confirm 明确确认回滚");
  }
  const releaseLock = await acquireLock(rootDir);
  try {
    const storageRoot = options.storageRoot ?? rootDir;
    const activePath = path.join(storageRoot, "themes", "active.json");
    const active = await validateConfiguredTheme(rootDir, storageRoot);
    if (!active?.previous) throw new ThemePipelineError("rollback", "当前主题没有可回滚版本");
    const target = active.previous;
    const { definition, relativeCssPath } = await loadStoredTheme(rootDir, target.themeId, target.revision);
    const nextActive = {
      ...createThemeManifest(
        definition,
        relativeCssPath,
        null,
      ),
      previous: { themeId: active.themeId, revision: active.revision },
    };
    const stages = [
      await stageFile(
        path.join(storageRoot, "config", "theme.json"),
        themeConfigSource(target.themeId, target.revision),
      ),
      await stageFile(activePath, stableJson(nextActive)),
    ];
    await commitStages(stages);
    return {
      result: "rolled-back",
      themeId: target.themeId,
      revision: target.revision,
      previous: nextActive.previous,
    };
  } finally {
    await releaseLock();
  }
}

export async function validateActiveTheme(rootDir, storageRoot = rootDir) {
  const activePath = path.join(storageRoot, "themes", "active.json");
  const active = await readJson(activePath);
  if (!active) return null;
  if (
    active.schemaVersion !== 1
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(active.themeId ?? "")
    || !Number.isInteger(active.revision)
    || active.revision < 1
    || !SUPPORTED_THEME_COMPILER_VERSIONS.has(active.compilerVersion)
  ) {
    throw new ThemePipelineError("active", "Schema、主题 ID、Revision 或编译器版本无效");
  }
  const expectedCssPath = `/themes/compiled/${active.themeId}/${active.revision}.css`;
  if (active.cssPath !== expectedCssPath) {
    throw new ThemePipelineError("active.cssPath", "必须指向对应 Theme Revision 的受控编译产物");
  }
  const definitionPath = path.join(rootDir, "themes", "definitions", active.themeId, `${active.revision}.json`);
  const definition = await readJson(definitionPath);
  const compiledPath = path.join(rootDir, expectedCssPath.slice(1));
  if (!definition || !await fileExists(compiledPath)) {
    throw new ThemePipelineError("active", "指向的 Definition 或编译产物不存在");
  }
  if (
    definition.id !== active.themeId
    || definition.revision !== active.revision
    || definition.compilerVersion !== active.compilerVersion
  ) {
    throw new ThemePipelineError("active", "与指向的 Definition 元数据不一致");
  }
  const compiled = await readFile(compiledPath, "utf8");
  const header = `schemaVersion=${active.schemaVersion} | id=${active.themeId} | revision=${active.revision} | compiler=${active.compilerVersion}`;
  if (!compiled.startsWith(`/* DailyNews Theme | ${header}`)) {
    throw new ThemePipelineError("active", "与指向的编译产物元数据不一致");
  }
  return active;
}

export async function validateConfiguredTheme(rootDir, storageRoot = rootDir) {
  const selection = await validateThemeConfig(rootDir, storageRoot);
  const active = await validateActiveTheme(rootDir, storageRoot);
  if (!active) throw new ThemePipelineError("active", "不存在，无法应用 config/theme.json");
  if (
    active.themeId !== selection.activeTheme.id
    || active.revision !== selection.activeTheme.revision
  ) {
    throw new ThemePipelineError(
      selection.inherited ? "config/home.json.activeTheme" : "config/theme.json.activeTheme",
      `与 Active Theme 不一致，请使用 switch-theme 修改${selection.inherited ? " Home Theme" : "当前主题"}`,
    );
  }
  return active;
}
