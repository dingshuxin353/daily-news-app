import { contrastRatio, mergeThemes, THEME_SCHEMA_VERSION } from "./theme.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "id", "name", "description", "extends", "tokens", "recipes"]);
const TOKEN_FIELDS = new Set(["colors", "typography", "density", "ruleStyle", "surfaceStyle", "motion"]);
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
  constructor(source, field, message) {
    super(`${source}: ${field} ${message}`);
    this.name = "ThemeValidationError";
    this.filePath = source;
    this.field = field;
  }
}

function fail(source, field, message) {
  throw new ThemeValidationError(source, field, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, source, field) {
  if (!isObject(value)) fail(source, field, "必须是对象");
}

function requireString(value, source, field) {
  if (typeof value !== "string" || value.trim() === "") fail(source, field, "必须是非空字符串");
}

function requireFields(value, allowed, source, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(source, `${field}.${key}`, "不是允许的主题字段");
  }
}

function requireEnum(value, name, source, field) {
  if (!ENUMS[name].has(value)) fail(source, field, `只能是 ${[...ENUMS[name]].join("、")}`);
}

function validateTokens(tokens, source, partial) {
  requireObject(tokens, source, "tokens");
  requireFields(tokens, TOKEN_FIELDS, source, "tokens");
  if (tokens.colors !== undefined) {
    requireObject(tokens.colors, source, "tokens.colors");
    requireFields(tokens.colors, COLOR_FIELDS, source, "tokens.colors");
    for (const [key, value] of Object.entries(tokens.colors)) {
      if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
        fail(source, `tokens.colors.${key}`, "必须是六位十六进制颜色 #RRGGBB");
      }
    }
  }
  if (tokens.typography !== undefined) {
    requireObject(tokens.typography, source, "tokens.typography");
    requireFields(tokens.typography, TYPOGRAPHY_FIELDS, source, "tokens.typography");
    for (const key of Object.keys(tokens.typography)) {
      requireEnum(tokens.typography[key], key, source, `tokens.typography.${key}`);
    }
  }
  for (const key of ["density", "ruleStyle", "surfaceStyle", "motion"]) {
    if (tokens[key] !== undefined) requireEnum(tokens[key], key, source, `tokens.${key}`);
  }
  if (!partial) {
    for (const key of TOKEN_FIELDS) {
      if (tokens[key] === undefined) fail(source, `tokens.${key}`, "根 Preset 必须提供完整值");
    }
    for (const key of COLOR_FIELDS) {
      if (tokens.colors[key] === undefined) fail(source, `tokens.colors.${key}`, "根 Preset 必须提供完整值");
    }
    for (const key of TYPOGRAPHY_FIELDS) {
      if (tokens.typography[key] === undefined) fail(source, `tokens.typography.${key}`, "根 Preset 必须提供完整值");
    }
  }
}

function validateRecipes(recipes, source, partial) {
  requireObject(recipes, source, "recipes");
  requireFields(recipes, RECIPE_FIELDS, source, "recipes");
  for (const [key, value] of Object.entries(recipes)) requireEnum(value, key, source, `recipes.${key}`);
  if (!partial) {
    for (const key of RECIPE_FIELDS) {
      if (recipes[key] === undefined) fail(source, `recipes.${key}`, "根 Preset 必须提供完整值");
    }
  }
}

function hasOverrides(theme) {
  const tokenCount = Object.entries(theme.tokens).reduce((count, [key, value]) => (
    count + (isObject(value) ? Object.keys(value).length : 1)
  ), 0);
  return tokenCount + Object.keys(theme.recipes).length > 0;
}

export function validateThemeValue(theme, options = {}) {
  const { source = theme?.id ?? "theme", kind = "candidate", isRoot = false } = options;
  requireObject(theme, source, "$");
  requireFields(theme, TOP_LEVEL_FIELDS, source, "$");
  if (theme.schemaVersion !== THEME_SCHEMA_VERSION) fail(source, "schemaVersion", "必须等于 1");
  requireString(theme.id, source, "id");
  if (!ID_PATTERN.test(theme.id)) fail(source, "id", "只能包含小写字母、数字和连字符");
  requireString(theme.name, source, "name");
  if (theme.description !== undefined) requireString(theme.description, source, "description");
  if (kind === "candidate" || !isRoot) {
    requireString(theme.extends, source, "extends");
    if (!ID_PATTERN.test(theme.extends)) fail(source, "extends", "必须是合法 Preset ID");
  } else if (theme.extends !== undefined) {
    fail(source, "extends", "根 Preset 不能继承其他主题");
  }
  validateTokens(theme.tokens, source, kind === "candidate" || !isRoot);
  validateRecipes(theme.recipes, source, kind === "candidate" || !isRoot);
  if (kind === "candidate" && !hasOverrides(theme)) {
    fail(source, "tokens/recipes", "合计至少需要一个实际覆盖字段");
  }
  return theme;
}

export function validateThemeReadability(theme, source = theme.id) {
  const { background, text, muted } = theme.tokens.colors;
  for (const [name, color] of [["text", text], ["muted", muted]]) {
    const ratio = contrastRatio(color, background);
    if (ratio < 4.5) {
      fail(source, `tokens.colors.${name}`, `与 background 的对比度 ${ratio.toFixed(2)}:1 低于 4.5:1`);
    }
  }
  return theme;
}

export async function resolveThemeCandidateValue(candidate, options) {
  const { loadPreset, source = candidate?.id ?? "Theme Candidate" } = options ?? {};
  if (typeof loadPreset !== "function") throw new TypeError("Theme Resolver 必须提供 loadPreset");
  validateThemeValue(candidate, { source, kind: "candidate" });
  const preset = await loadPreset(candidate.extends);
  const resolved = mergeThemes(preset, candidate);
  if (
    JSON.stringify(resolved.tokens) === JSON.stringify(preset.tokens)
    && JSON.stringify(resolved.recipes) === JSON.stringify(preset.recipes)
  ) {
    fail(source, "tokens/recipes", "必须实际改变继承 Preset 的至少一个视觉值");
  }
  validateThemeReadability(resolved, source);
  return {
    candidate,
    resolved,
    usesSiteAccent: candidate.tokens.colors?.accent === undefined
      && candidate.extends === "newspaper-default",
  };
}
