import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const THEME_SCHEMA_VERSION = 1;
export const THEME_COMPILER_VERSION = "2";
export const SUPPORTED_THEME_COMPILER_VERSIONS = new Set(["1", THEME_COMPILER_VERSION]);

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "id",
  "name",
  "description",
  "extends",
  "tokens",
  "recipes",
]);
const TOKEN_FIELDS = new Set([
  "colors",
  "typography",
  "density",
  "ruleStyle",
  "surfaceStyle",
  "motion",
]);
const COLOR_FIELDS = new Set(["background", "text", "muted", "accent", "rule"]);
const TYPOGRAPHY_FIELDS = new Set(["headlinePreset", "uiPreset", "headlineScale"]);
const RECIPE_FIELDS = new Set(["masthead", "lead", "important", "normal"]);
const ENUMS = Object.freeze({
  headlinePreset: new Set(["serif-cn", "sans-cn", "mono"]),
  uiPreset: new Set(["sans-cn", "serif-cn", "mono"]),
  headlineScale: new Set(["restrained", "editorial", "poster"]),
  density: new Set(["compact", "balanced", "spacious"]),
  ruleStyle: new Set(["hairline", "strong", "double"]),
  surfaceStyle: new Set(["flat", "paper", "soft-gradient"]),
  motion: new Set(["none", "subtle"]),
  masthead: new Set(["compact", "classic", "banner"]),
  lead: new Set(["split", "stacked", "editorial"]),
  important: new Set(["ruled", "minimal", "contrast"]),
  normal: new Set(["compact", "minimal", "accent"]),
});

export class ThemeValidationError extends Error {
  constructor(filePath, field, message) {
    super(`${filePath}: ${field} ${message}`);
    this.name = "ThemeValidationError";
    this.filePath = filePath;
    this.field = field;
  }
}

function fail(filePath, field, message) {
  throw new ThemeValidationError(filePath, field, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, filePath, field) {
  if (!isObject(value)) fail(filePath, field, "必须是对象");
}

function requireString(value, filePath, field) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(filePath, field, "必须是非空字符串");
  }
}

function requireFields(value, allowed, filePath, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(filePath, `${field}.${key}`, "不是允许的主题字段");
  }
}

function requireEnum(value, name, filePath, field) {
  if (!ENUMS[name].has(value)) {
    fail(filePath, field, `只能是 ${[...ENUMS[name]].join("、")}`);
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

function validateTokens(tokens, filePath, partial) {
  requireObject(tokens, filePath, "tokens");
  requireFields(tokens, TOKEN_FIELDS, filePath, "tokens");

  if (tokens.colors !== undefined) {
    requireObject(tokens.colors, filePath, "tokens.colors");
    requireFields(tokens.colors, COLOR_FIELDS, filePath, "tokens.colors");
    for (const [key, value] of Object.entries(tokens.colors)) {
      if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
        fail(filePath, `tokens.colors.${key}`, "必须是六位十六进制颜色 #RRGGBB");
      }
    }
  }

  if (tokens.typography !== undefined) {
    requireObject(tokens.typography, filePath, "tokens.typography");
    requireFields(tokens.typography, TYPOGRAPHY_FIELDS, filePath, "tokens.typography");
    for (const key of Object.keys(tokens.typography)) {
      requireEnum(tokens.typography[key], key, filePath, `tokens.typography.${key}`);
    }
  }

  for (const key of ["density", "ruleStyle", "surfaceStyle", "motion"]) {
    if (tokens[key] !== undefined) requireEnum(tokens[key], key, filePath, `tokens.${key}`);
  }

  if (!partial) {
    for (const key of TOKEN_FIELDS) {
      if (tokens[key] === undefined) fail(filePath, `tokens.${key}`, "根 Preset 必须提供完整值");
    }
    for (const key of COLOR_FIELDS) {
      if (tokens.colors[key] === undefined) fail(filePath, `tokens.colors.${key}`, "根 Preset 必须提供完整值");
    }
    for (const key of TYPOGRAPHY_FIELDS) {
      if (tokens.typography[key] === undefined) fail(filePath, `tokens.typography.${key}`, "根 Preset 必须提供完整值");
    }
  }
}

function validateRecipes(recipes, filePath, partial) {
  requireObject(recipes, filePath, "recipes");
  requireFields(recipes, RECIPE_FIELDS, filePath, "recipes");
  for (const [key, value] of Object.entries(recipes)) {
    requireEnum(value, key, filePath, `recipes.${key}`);
  }
  if (!partial) {
    for (const key of RECIPE_FIELDS) {
      if (recipes[key] === undefined) fail(filePath, `recipes.${key}`, "根 Preset 必须提供完整值");
    }
  }
}

function hasOverrides(theme) {
  const tokenCount = Object.entries(theme.tokens).reduce((count, [key, value]) => (
    count + (isObject(value) ? Object.keys(value).length : 1)
  ), 0);
  return tokenCount + Object.keys(theme.recipes).length > 0;
}

function validateShape(theme, filePath, kind, isRoot = false) {
  requireObject(theme, filePath, "$");
  requireFields(theme, TOP_LEVEL_FIELDS, filePath, "$");
  if (theme.schemaVersion !== THEME_SCHEMA_VERSION) fail(filePath, "schemaVersion", "必须等于 1");
  requireString(theme.id, filePath, "id");
  if (!ID_PATTERN.test(theme.id)) fail(filePath, "id", "只能包含小写字母、数字和连字符");
  requireString(theme.name, filePath, "name");
  if (theme.description !== undefined) requireString(theme.description, filePath, "description");

  if (kind === "candidate" || !isRoot) {
    requireString(theme.extends, filePath, "extends");
    if (!ID_PATTERN.test(theme.extends)) fail(filePath, "extends", "必须是合法 Preset ID");
  } else if (theme.extends !== undefined) {
    fail(filePath, "extends", "根 Preset 不能继承其他主题");
  }

  validateTokens(theme.tokens, filePath, kind === "candidate" || !isRoot);
  validateRecipes(theme.recipes, filePath, kind === "candidate" || !isRoot);
  if (kind === "candidate" && !hasOverrides(theme)) {
    fail(filePath, "tokens/recipes", "合计至少需要一个实际覆盖字段");
  }
  return theme;
}

export async function validateThemeCandidate(filePath) {
  const candidate = validateShape(await readJson(filePath), filePath, "candidate");
  if (path.basename(filePath) !== `${candidate.id}.json`) {
    fail(filePath, "id", "必须与候选文件名一致");
  }
  return candidate;
}

export async function loadPreset(rootDir, presetId, seen = new Set()) {
  if (!ID_PATTERN.test(presetId)) fail(presetId, "id", "不是合法 Preset ID");
  if (seen.has(presetId)) fail(presetId, "extends", "Preset 继承存在循环");
  const nextSeen = new Set(seen).add(presetId);
  const filePath = path.join(rootDir, "themes", "presets", `${presetId}.json`);
  const preset = await readJson(filePath);
  if (preset.id !== presetId) fail(filePath, "id", "必须与 Preset 文件名一致");
  validateShape(preset, filePath, "preset", preset.extends === undefined);
  if (preset.extends === undefined) return structuredClone(preset);
  const parent = await loadPreset(rootDir, preset.extends, nextSeen);
  return mergeThemes(parent, preset);
}

export function mergeThemes(base, override) {
  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: override.id,
    name: override.name,
    ...(override.description === undefined ? {} : { description: override.description }),
    extends: override.extends,
    tokens: {
      ...structuredClone(base.tokens),
      ...structuredClone(override.tokens),
      colors: { ...structuredClone(base.tokens.colors), ...structuredClone(override.tokens.colors ?? {}) },
      typography: {
        ...structuredClone(base.tokens.typography),
        ...structuredClone(override.tokens.typography ?? {}),
      },
    },
    recipes: { ...structuredClone(base.recipes), ...structuredClone(override.recipes) },
  };
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color) {
  const rgb = (color) => [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
  const [red, green, blue] = rgb(color).map(channel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function validateThemeReadability(theme, filePath = theme.id) {
  const { background, text, muted } = theme.tokens.colors;
  for (const [name, color] of [["text", text], ["muted", muted]]) {
    const ratio = contrastRatio(color, background);
    if (ratio < 4.5) {
      fail(filePath, `tokens.colors.${name}`, `与 background 的对比度 ${ratio.toFixed(2)}:1 低于 4.5:1`);
    }
  }
  return theme;
}

export async function resolveThemeCandidate(rootDir, candidatePath) {
  const resolvedRoot = await realpath(path.resolve(rootDir));
  const resolvedPath = await realpath(path.resolve(candidatePath));
  const candidateRoot = path.join(resolvedRoot, "themes", "candidates");
  if (!resolvedPath.startsWith(`${candidateRoot}${path.sep}`)) {
    fail(resolvedPath, "$", "主题候选必须位于 themes/candidates/ 目录");
  }
  const candidate = await validateThemeCandidate(resolvedPath);
  const preset = await loadPreset(resolvedRoot, candidate.extends);
  const resolved = mergeThemes(preset, candidate);
  if (
    JSON.stringify(resolved.tokens) === JSON.stringify(preset.tokens)
    && JSON.stringify(resolved.recipes) === JSON.stringify(preset.recipes)
  ) {
    fail(resolvedPath, "tokens/recipes", "必须实际改变继承 Preset 的至少一个视觉值");
  }
  validateThemeReadability(resolved, resolvedPath);
  return {
    candidate,
    resolved,
    usesSiteAccent: candidate.tokens.colors?.accent === undefined
      && candidate.extends === "newspaper-default",
  };
}
