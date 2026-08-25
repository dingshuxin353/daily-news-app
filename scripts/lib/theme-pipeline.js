import path from "node:path";

import {
  createThemeApplicationService,
  ThemeServiceError,
} from "./application/theme-service.js";
import { commitStages, stageFile } from "./storage/atomic-file.js";
import { acquireThemeFileLock, createFileThemeStorage } from "./storage/file-theme.js";
import { resolveThemeCandidate } from "./theme-validation.js";

export { commitStages, stageFile };
export const ThemePipelineError = ThemeServiceError;

function fileService(rootDir, storageRoot = rootDir) {
  const storage = createFileThemeStorage({ rootDir, storageRoot });
  return { storage, service: createThemeApplicationService(storage) };
}

export function acquireLock(rootDir) {
  return acquireThemeFileLock(rootDir);
}

export async function processTheme(rootDir, candidatePath) {
  const input = await resolveThemeCandidate(rootDir, candidatePath);
  const { storage, service } = fileService(rootDir);
  const result = await service.preview(input);
  return { ...result, preview: storage.previewLocator(input.candidate.id) };
}

export function loadStoredTheme(rootDir, themeId, revision) {
  return fileService(rootDir).service.loadRevision(themeId, revision);
}

export async function activateTheme(rootDir, themeId, options = {}) {
  if (options.confirm !== themeId) {
    throw new ThemeServiceError("authorization", `必须使用 --confirm ${themeId} 明确确认激活`);
  }
  const candidatePath = path.join(rootDir, "themes", "candidates", `${themeId}.json`);
  const input = await resolveThemeCandidate(rootDir, candidatePath);
  return fileService(rootDir, options.storageRoot ?? rootDir).service.activate(input);
}

export function listThemes(rootDir, storageRoot = rootDir) {
  return fileService(rootDir, storageRoot).service.list();
}

export async function switchTheme(rootDir, themeId, options = {}) {
  if (options.confirm !== themeId) {
    throw new ThemeServiceError("authorization", `必须使用 --confirm ${themeId} 明确确认切换`);
  }
  return fileService(rootDir, options.storageRoot ?? rootDir).service.switch({
    themeId,
    revision: options.revision,
  });
}

export async function inheritTheme(rootDir, options = {}) {
  if (options.confirm !== true) {
    throw new ThemeServiceError("authorization", "必须使用 --confirm 明确确认恢复继承");
  }
  const storageRoot = options.storageRoot;
  if (!storageRoot || path.resolve(storageRoot) === path.resolve(rootDir)) {
    throw new ThemeServiceError("storageRoot", "恢复继承只适用于明确的 Publication");
  }
  return fileService(rootDir, storageRoot).service.inherit();
}

export async function rollbackTheme(rootDir, options = {}) {
  if (options.confirm !== true) {
    throw new ThemeServiceError("authorization", "必须使用 --confirm 明确确认回滚");
  }
  return fileService(rootDir, options.storageRoot ?? rootDir).service.rollback();
}

export function validateActiveTheme(rootDir, storageRoot = rootDir) {
  return fileService(rootDir, storageRoot).service.validateActive();
}

export function validateConfiguredTheme(rootDir, storageRoot = rootDir) {
  return fileService(rootDir, storageRoot).service.validateConfigured();
}
