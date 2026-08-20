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

async function writeAtomic(filePath, source) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, source, { flag: "wx" });
  await rename(temporaryPath, filePath);
}

async function stageFile(filePath, source) {
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

async function commitStages(stages) {
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

async function acquireLock(rootDir) {
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

export async function validateThemeStressFixture(rootDir) {
  const filePath = path.join(rootDir, "themes", "fixtures", "stress-issue.json");
  const issue = await readJson(filePath);
  if (!issue || !Array.isArray(issue.items) || !Array.isArray(issue.layout?.rows)) {
    throw new ThemePipelineError("stressFixture", "必须包含 items 和 layout.rows");
  }
  const ids = issue.items.map(({ id }) => id);
  const layoutIds = issue.layout.rows.flatMap(({ modules }) => modules.map(({ itemId }) => itemId));
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(layoutIds)) {
    throw new ThemePipelineError("stressFixture", "内容 ID 必须唯一且与版面阅读顺序一致");
  }
  const signatures = issue.layout.rows.map(({ modules }) => modules.map(({ size }) => size[0].toUpperCase()).join(""));
  for (const required of ["L", "MM", "MSS", "SSSS"]) {
    if (!signatures.includes(required)) throw new ThemePipelineError("stressFixture", `缺少 ${required} 行型`);
  }
  if (!issue.layout.rows.some(({ usedCapacity }) => usedCapacity < 4)) {
    throw new ThemePipelineError("stressFixture", "缺少未填满的最后一行");
  }
  if (!issue.items.some(({ category }) => category === undefined)) {
    throw new ThemePipelineError("stressFixture", "缺少无分类内容");
  }
  if (!issue.items.some(({ sources }) => sources.length > 1)) {
    throw new ThemePipelineError("stressFixture", "缺少多来源内容");
  }
  return { filePath, signatures };
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
    checks: (await validateThemeStressFixture(rootDir)).signatures,
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
  const definitionDir = path.join(rootDir, "themes", "definitions", themeId);
  const names = await readdir(definitionDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const revisions = names
    .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  return revisions.length === 0 ? 1 : Math.max(...revisions) + 1;
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
    const activePath = path.join(rootDir, "themes", "active.json");
    const active = await readJson(activePath);
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
    const nextActive = {
      ...createThemeManifest(definition, relativeCssPath, candidateHash),
      previous: active ? { themeId: active.themeId, revision: active.revision } : null,
    };
    const stages = [
      await stageFile(definitionPath, stableJson(definition)),
      await stageFile(compiledPath, css),
      await stageFile(activePath, stableJson(nextActive)),
    ];
    await commitStages(stages);
    return { result: "activated", themeId, revision, previous: nextActive.previous };
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
    const activePath = path.join(rootDir, "themes", "active.json");
    const active = await readJson(activePath);
    if (!active?.previous) throw new ThemePipelineError("rollback", "当前主题没有可回滚版本");
    const target = active.previous;
    const definitionPath = path.join(rootDir, "themes", "definitions", target.themeId, `${target.revision}.json`);
    const definition = await readJson(definitionPath);
    const compiledPath = path.join(rootDir, "themes", "compiled", target.themeId, `${target.revision}.css`);
    if (!definition || !await fileExists(compiledPath)) {
      throw new ThemePipelineError("rollback", "目标 Theme Revision 或编译产物不存在");
    }
    const nextActive = {
      ...createThemeManifest(
        definition,
        `/themes/compiled/${target.themeId}/${target.revision}.css`,
        null,
      ),
      previous: { themeId: active.themeId, revision: active.revision },
    };
    await writeAtomic(activePath, stableJson(nextActive));
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

export async function validateActiveTheme(rootDir) {
  const activePath = path.join(rootDir, "themes", "active.json");
  const active = await readJson(activePath);
  if (!active) return null;
  if (
    active.schemaVersion !== 1
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(active.themeId ?? "")
    || !Number.isInteger(active.revision)
    || active.revision < 1
    || active.compilerVersion !== THEME_COMPILER_VERSION
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
