export const THEME_SCHEMA_VERSION = 1;
export const THEME_COMPILER_VERSION = "2";
export const SUPPORTED_THEME_COMPILER_VERSIONS = new Set(["1", THEME_COMPILER_VERSION]);

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
  const rgb = (value) => [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16));
  const [red, green, blue] = rgb(color).map(channel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
