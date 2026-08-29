import type { PostgresPool } from "../../adapters/postgres/pool.js";
import { PostgresThemeStorage, ThemeStorageError, type SystemThemeReader } from "../../adapters/postgres/theme.js";
import type { TenantContext } from "../../adapters/postgres/tenancy.js";
import { requireTenantContext } from "../../adapters/postgres/tenancy.js";

export interface BrowserThemePreview {
  background: string;
  text: string;
  muted: string;
  accent: string;
  rule: string;
}

export interface BrowserTheme {
  themeId: string;
  name: string;
  source: "official" | "custom";
  revision: number;
  preview: BrowserThemePreview;
}

function color(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme preview colors are unavailable");
  }
  return value;
}

function preview(definition: Record<string, unknown>): BrowserThemePreview {
  const tokens = definition.tokens;
  const colors = tokens && typeof tokens === "object" && !Array.isArray(tokens)
    ? (tokens as Record<string, unknown>).colors
    : null;
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) {
    throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme preview colors are unavailable");
  }
  const palette = colors as Record<string, unknown>;
  return {
    background: color(palette, "background"),
    text: color(palette, "text"),
    muted: color(palette, "muted"),
    accent: color(palette, "accent"),
    rule: color(palette, "rule"),
  };
}

export class SiteThemeCatalogService {
  constructor(
    private readonly pool: PostgresPool,
    private readonly systemThemes: SystemThemeReader,
  ) {}

  async list(tenant: TenantContext): Promise<BrowserTheme[]> {
    requireTenantContext(tenant);
    const storage = new PostgresThemeStorage(this.pool, tenant, this.systemThemes);
    const summaries = await storage.listThemes();
    return Promise.all(summaries.map(async (summary) => {
      const current = await storage.readCurrentTheme(summary.themeId);
      if (!current || current.revision !== summary.revision) {
        throw new ThemeStorageError("THEME_STORAGE_FAILED", "theme catalog changed while being read");
      }
      return { ...summary, preview: preview(current.definition) };
    }));
  }
}
