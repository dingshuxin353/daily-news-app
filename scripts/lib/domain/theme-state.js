import { sameValue } from "./value.js";

const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ThemeStateError extends Error {
  constructor(field, message) {
    super(`${field} ${message}`);
    this.name = "ThemeStateError";
    this.field = field;
  }
}

function requireExactFields(value, fields, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThemeStateError(field, "必须是对象");
  }
  const expected = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new ThemeStateError(`${field}.${key}`, "不是允许的配置字段");
  }
  for (const key of fields) {
    if (!(key in value)) throw new ThemeStateError(`${field}.${key}`, "不能为空");
  }
}

function validateReference(reference, field) {
  requireExactFields(reference, ["id", "revision"], field);
  if (!THEME_ID_PATTERN.test(reference.id)) {
    throw new ThemeStateError(`${field}.id`, "只能包含小写字母、数字和连字符");
  }
  if (!Number.isInteger(reference.revision) || reference.revision < 1) {
    throw new ThemeStateError(`${field}.revision`, "必须是大于等于 1 的整数");
  }
  return reference;
}

export function createOverrideThemeConfig(themeId, revision) {
  validateReference({ id: themeId, revision }, "activeTheme");
  return { schemaVersion: 2, mode: "override", activeTheme: { id: themeId, revision } };
}

export function resolveThemeSelection(config, options = {}) {
  if (!config) throw new ThemeStateError("config/theme.json", "不存在");
  if (config.schemaVersion === 1) {
    requireExactFields(config, ["schemaVersion", "activeTheme"], "config/theme.json");
    validateReference(config.activeTheme, "config/theme.json.activeTheme");
    return { config, activeTheme: config.activeTheme, inherited: false, legacy: true };
  }
  if (config.schemaVersion !== 2) {
    throw new ThemeStateError("config/theme.json.schemaVersion", "必须等于 2");
  }
  if (config.mode === "inherit") {
    requireExactFields(config, ["schemaVersion", "mode"], "config/theme.json");
    if (!options.homeActiveTheme) {
      throw new ThemeStateError("config/home.json.activeTheme", "不存在，无法继承主页主题");
    }
    validateReference(options.homeActiveTheme, "config/home.json.activeTheme");
    return { config, activeTheme: options.homeActiveTheme, inherited: true, legacy: false };
  }
  if (config.mode !== "override") {
    throw new ThemeStateError("config/theme.json.mode", "只能是 inherit 或 override");
  }
  requireExactFields(config, ["schemaVersion", "mode", "activeTheme"], "config/theme.json");
  validateReference(config.activeTheme, "config/theme.json.activeTheme");
  return { config, activeTheme: config.activeTheme, inherited: false, legacy: false };
}

export function nextThemeRevision(revisions) {
  if (!Array.isArray(revisions) || revisions.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new ThemeStateError("revisions", "必须是正整数数组");
  }
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

export function sameThemeDefinition(left, right) {
  return sameValue(semanticDefinition(left), semanticDefinition(right));
}

export function validateActiveThemePointer(active, supportedCompilerVersions) {
  if (
    !active
    || active.schemaVersion !== 1
    || !THEME_ID_PATTERN.test(active.themeId ?? "")
    || !Number.isInteger(active.revision)
    || active.revision < 1
    || !supportedCompilerVersions.has(active.compilerVersion)
  ) {
    throw new ThemeStateError("active", "Schema、主题 ID、Revision 或编译器版本无效");
  }
  const expectedCssPath = `/themes/compiled/${active.themeId}/${active.revision}.css`;
  if (active.cssPath !== expectedCssPath) {
    throw new ThemeStateError("active.cssPath", "必须指向对应 Theme Revision 的受控编译产物");
  }
  return active;
}

export function assertActiveMatchesSelection(active, selection) {
  if (active.themeId !== selection.activeTheme.id || active.revision !== selection.activeTheme.revision) {
    throw new ThemeStateError(
      selection.inherited ? "config/home.json.activeTheme" : "config/theme.json.activeTheme",
      `与 Active Theme 不一致，请使用 switch-theme 修改${selection.inherited ? " Home Theme" : "当前主题"}`,
    );
  }
  return active;
}
