import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  contrastRatio,
  mergeThemes,
  relativeLuminance,
  SUPPORTED_THEME_COMPILER_VERSIONS,
  THEME_COMPILER_VERSION,
  THEME_SCHEMA_VERSION,
} from "./domain/theme.js";
import {
  resolveThemeCandidateValue,
  ThemeValidationError,
  validateThemeReadability,
  validateThemeValue,
} from "./domain/theme-validation.js";

export {
  contrastRatio,
  mergeThemes,
  relativeLuminance,
  SUPPORTED_THEME_COMPILER_VERSIONS,
  THEME_COMPILER_VERSION,
  THEME_SCHEMA_VERSION,
  ThemeValidationError,
  validateThemeReadability,
  validateThemeValue,
};

function fail(source, field, message) {
  throw new ThemeValidationError(source, field, message);
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

export async function validateThemeCandidate(filePath) {
  const candidate = validateThemeValue(await readJson(filePath), { source: filePath, kind: "candidate" });
  if (path.basename(filePath) !== `${candidate.id}.json`) fail(filePath, "id", "必须与候选文件名一致");
  return candidate;
}

export async function loadPreset(rootDir, presetId, seen = new Set()) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetId)) fail(presetId, "id", "不是合法 Preset ID");
  if (seen.has(presetId)) fail(presetId, "extends", "Preset 继承存在循环");
  const nextSeen = new Set(seen).add(presetId);
  const filePath = path.join(rootDir, "themes", "presets", `${presetId}.json`);
  const preset = await readJson(filePath);
  if (preset.id !== presetId) fail(filePath, "id", "必须与 Preset 文件名一致");
  validateThemeValue(preset, {
    source: filePath,
    kind: "preset",
    isRoot: preset.extends === undefined,
  });
  if (preset.extends === undefined) return structuredClone(preset);
  const parent = await loadPreset(rootDir, preset.extends, nextSeen);
  return mergeThemes(parent, preset);
}

export async function resolveThemeCandidate(rootDir, candidatePath) {
  const resolvedRoot = await realpath(path.resolve(rootDir));
  const resolvedPath = await realpath(path.resolve(candidatePath));
  const candidateRoot = path.join(resolvedRoot, "themes", "candidates");
  if (!resolvedPath.startsWith(`${candidateRoot}${path.sep}`)) {
    fail(resolvedPath, "$", "主题候选必须位于 themes/candidates/ 目录");
  }
  const candidate = await validateThemeCandidate(resolvedPath);
  return resolveThemeCandidateValue(candidate, {
    source: resolvedPath,
    loadPreset: (presetId) => loadPreset(resolvedRoot, presetId),
  });
}
