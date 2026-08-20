import { createHash } from "node:crypto";

import { contrastRatio, THEME_COMPILER_VERSION } from "./theme-validation.js";

const FONT_STACKS = Object.freeze({
  "serif-cn": 'ui-serif, "Songti SC", "Noto Serif CJK SC", STSong, serif',
  "sans-cn": 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
  mono: 'ui-monospace, "SFMono-Regular", "Cascadia Mono", "Noto Sans Mono CJK SC", monospace',
});

const DENSITIES = Object.freeze({
  compact: { pageGutter: "38px", rowSpace: "22px", storyGap: "18px", sourceGap: "16px" },
  balanced: { pageGutter: "48px", rowSpace: "30px", storyGap: "24px", sourceGap: "22px" },
  spacious: { pageGutter: "64px", rowSpace: "42px", storyGap: "32px", sourceGap: "28px" },
});

const RULES = Object.freeze({
  hairline: { width: "1px", style: "solid" },
  strong: { width: "2px", style: "solid" },
  double: { width: "3px", style: "double" },
});

const SCALES = Object.freeze({
  restrained: { large: "clamp(48px, 5vw, 68px)", medium: "clamp(30px, 3vw, 40px)", small: "clamp(23px, 2vw, 29px)" },
  editorial: { large: "clamp(56px, 6vw, 82px)", medium: "clamp(34px, 3.25vw, 46px)", small: "clamp(25px, 2.25vw, 32px)" },
  poster: { large: "clamp(64px, 7.2vw, 98px)", medium: "clamp(38px, 4vw, 54px)", small: "clamp(27px, 2.6vw, 36px)" },
});

const SURFACES = Object.freeze({
  flat: "var(--color-background)",
  paper: "linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 5%, transparent), transparent 30%), var(--color-background)",
  "soft-gradient": "radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--color-accent) 13%, transparent), transparent 38%), linear-gradient(145deg, var(--color-background), color-mix(in srgb, var(--color-background) 88%, var(--color-text)))",
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function contentHash(value) {
  const source = typeof value === "string" ? value : stableJson(value);
  return createHash("sha256").update(source).digest("hex");
}

export function themeAttributes(theme) {
  return {
    theme: theme.id,
    density: theme.tokens.density,
    surface: theme.tokens.surfaceStyle,
    motion: theme.tokens.motion,
    masthead: theme.recipes.masthead,
    lead: theme.recipes.lead,
    important: theme.recipes.important,
    normal: theme.recipes.normal,
  };
}

function mixHex(first, second, amount) {
  const channels = (color) => [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
  const left = channels(first);
  const right = channels(second);
  return `#${left.map((value, index) => (
    Math.round(value * amount + right[index] * (1 - amount)).toString(16).padStart(2, "0")
  )).join("")}`.toUpperCase();
}

function accentTextColor(colors) {
  if (contrastRatio(colors.accent, colors.background) >= 4.5) return colors.accent.toUpperCase();
  for (let amount = 0.5; amount >= 0; amount -= 0.05) {
    const mixed = mixHex(colors.accent, colors.text, amount);
    if (contrastRatio(mixed, colors.background) >= 4.5) return mixed;
  }
  return colors.text.toUpperCase();
}

export function compileThemeCss(theme, revision, options = {}) {
  const { colors, typography } = theme.tokens;
  const density = DENSITIES[theme.tokens.density];
  const rule = RULES[theme.tokens.ruleStyle];
  const scale = SCALES[typography.headlineScale];
  const accent = options.usesSiteAccent ? "var(--site-accent)" : colors.accent.toUpperCase();
  const metadata = `DailyNews Theme | schemaVersion=${theme.schemaVersion} | id=${theme.id} | revision=${revision} | compiler=${THEME_COMPILER_VERSION}`;
  return `/* ${metadata} */
:root {
  --color-background: ${colors.background.toUpperCase()};
  --color-text: ${colors.text.toUpperCase()};
  --color-muted: ${colors.muted.toUpperCase()};
  --color-accent: ${accent};
  --color-accent-text: ${accentTextColor(colors)};
  --color-rule: ${colors.rule.toUpperCase()};
  --font-headline: ${FONT_STACKS[typography.headlinePreset]};
  --font-ui: ${FONT_STACKS[typography.uiPreset]};
  --page-gutter: ${density.pageGutter};
  --row-space: ${density.rowSpace};
  --story-gap: ${density.storyGap};
  --source-gap: ${density.sourceGap};
  --rule-width: ${rule.width};
  --rule-style: ${rule.style};
  --headline-large: ${scale.large};
  --headline-medium: ${scale.medium};
  --headline-small: ${scale.small};
  --surface-background: ${SURFACES[theme.tokens.surfaceStyle]};
}
`;
}

export function createThemeDefinition(theme, revision, options = {}) {
  return {
    schemaVersion: theme.schemaVersion,
    id: theme.id,
    name: theme.name,
    ...(theme.description === undefined ? {} : { description: theme.description }),
    revision,
    compilerVersion: THEME_COMPILER_VERSION,
    usesSiteAccent: Boolean(options.usesSiteAccent),
    tokens: structuredClone(theme.tokens),
    recipes: structuredClone(theme.recipes),
  };
}

export function createThemeManifest(definition, cssPath, candidateHash) {
  return {
    schemaVersion: definition.schemaVersion,
    themeId: definition.id,
    revision: definition.revision,
    compilerVersion: definition.compilerVersion,
    candidateHash,
    cssPath,
    attributes: themeAttributes(definition),
    colors: {
      background: definition.tokens.colors.background,
      text: definition.tokens.colors.text,
    },
  };
}
