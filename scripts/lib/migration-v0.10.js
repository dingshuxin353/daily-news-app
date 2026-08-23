import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateConfiguredTheme } from "./theme-pipeline.js";

export class V010MigrationError extends Error {
  constructor(field, message) {
    super(`${field} ${message}`);
    this.name = "V010MigrationError";
    this.field = field;
  }
}

function fail(field, message) {
  throw new V010MigrationError(field, message);
}

async function readJson(filePath, field) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(field, `无法读取合法 JSON（${error.code ?? error.message}）`);
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

export async function createV010MigrationPlan(rootDir, options = {}) {
  if (typeof options.enabled !== "boolean") fail("enabled", "必须明确为 true 或 false");
  const homePath = path.join(rootDir, "config", "home.json");
  if (await exists(homePath)) fail("config/home.json", "已存在，拒绝猜测合并");
  const registry = await readJson(
    path.join(rootDir, "config", "publications.json"),
    "config/publications.json",
  );
  if (
    registry?.schemaVersion !== 1
    || !Array.isArray(registry.publicationIds)
    || !registry.publicationIds.includes(registry.defaultPublicationId)
  ) {
    fail("config/publications.json", "不是合法 v0.10 Registry");
  }

  const selections = [];
  for (const publicationId of registry.publicationIds) {
    const publicationDir = path.join(rootDir, "publications", publicationId);
    const configPath = path.join(publicationDir, "config", "theme.json");
    const config = await readJson(configPath, `${publicationId}.config/theme.json`);
    if (config?.schemaVersion !== 1 || !config.activeTheme) {
      fail(`${publicationId}.config/theme.json`, "不是合法 v0.10 Theme Selection");
    }
    await validateConfiguredTheme(rootDir, publicationDir);
    selections.push({ publicationId, activeTheme: structuredClone(config.activeTheme) });
  }
  const defaultSelection = selections.find(
    ({ publicationId }) => publicationId === registry.defaultPublicationId,
  );
  return {
    schemaVersion: 1,
    migration: "v0.10.0-to-v0.11.0",
    home: {
      schemaVersion: 1,
      enabled: options.enabled,
      name: options.name ?? "我的日报",
      accentColor: options.accentColor ?? "#B37721",
      activeTheme: structuredClone(defaultSelection.activeTheme),
    },
    publicationThemes: selections.map(({ publicationId, activeTheme }) => ({
      publicationId,
      selection: publicationId === registry.defaultPublicationId
        ? { schemaVersion: 2, mode: "inherit" }
        : { schemaVersion: 2, mode: "override", activeTheme },
    })),
  };
}

async function stage(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const previous = await readFile(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  return { filePath, temporaryPath, previous };
}

async function restore(entry) {
  if (entry.previous === null) {
    await unlink(entry.filePath).catch(() => {});
    return;
  }
  const temporaryPath = `${entry.filePath}.${randomUUID()}.restore`;
  await writeFile(temporaryPath, entry.previous, { flag: "wx" });
  await rename(temporaryPath, entry.filePath);
}

export async function applyV010Migration(rootDir, plan, options = {}) {
  if (options.confirm !== "migrate-v0.11.0") {
    fail("authorization", "必须使用 --confirm migrate-v0.11.0 明确确认应用");
  }
  const fresh = await createV010MigrationPlan(rootDir, {
    enabled: plan?.home?.enabled,
    name: plan?.home?.name,
    accentColor: plan?.home?.accentColor,
  });
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) fail("plan", "与当前安装状态不一致");

  const entries = [
    await stage(path.join(rootDir, "config", "home.json"), plan.home),
  ];
  for (const item of plan.publicationThemes) {
    entries.push(await stage(
      path.join(rootDir, "publications", item.publicationId, "config", "theme.json"),
      item.selection,
    ));
  }
  const committed = [];
  try {
    for (const entry of entries) {
      await rename(entry.temporaryPath, entry.filePath);
      committed.push(entry);
    }
  } catch (error) {
    for (const entry of committed.reverse()) await restore(entry);
    throw error;
  } finally {
    await Promise.all(entries.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
  }
  return { result: "migrated", publications: plan.publicationThemes.length };
}
