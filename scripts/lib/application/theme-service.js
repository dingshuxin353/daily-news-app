import {
  compileThemeCss,
  contentHash,
  createThemeDefinition,
  createThemeManifest,
} from "../theme-compiler.js";
import {
  SUPPORTED_THEME_COMPILER_VERSIONS,
  THEME_COMPILER_VERSION,
} from "../domain/theme.js";
import {
  assertActiveMatchesSelection,
  createOverrideThemeConfig,
  nextThemeRevision,
  resolveThemeSelection,
  sameThemeDefinition,
  validateActiveThemePointer,
} from "../domain/theme-state.js";
import { requireThemeStorage, requireThemeWriteTransaction } from "../storage/ports.js";

const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ThemeServiceError extends Error {
  constructor(field, message) {
    super(`${field} ${message}`);
    this.name = "ThemeServiceError";
    this.field = field;
  }
}

function requireThemeId(themeId) {
  if (!THEME_ID_PATTERN.test(themeId ?? "")) {
    throw new ThemeServiceError("themeId", "只能包含小写字母、数字和连字符");
  }
}

function requireRevision(revision) {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ThemeServiceError("revision", "必须是大于等于 1 的整数");
  }
}

function inputHashes(candidate, resolved, usesSiteAccent) {
  return {
    candidateHash: contentHash(candidate),
    inputHash: contentHash({ candidate, resolved, usesSiteAccent }),
  };
}

async function loadRevision(reader, themeId, revision) {
  requireThemeId(themeId);
  requireRevision(revision);
  const stored = await reader.readThemeRevision(themeId, revision);
  if (!stored) throw new ThemeServiceError("theme", `Theme Revision 不存在：${themeId}@${revision}`);
  const { definition, css } = stored;
  if (
    definition.schemaVersion !== 1
    || definition.id !== themeId
    || definition.revision !== revision
    || !SUPPORTED_THEME_COMPILER_VERSIONS.has(definition.compilerVersion)
  ) {
    throw new ThemeServiceError("theme", `Theme Revision 元数据无效：${themeId}@${revision}`);
  }
  const header = `schemaVersion=${definition.schemaVersion} | id=${themeId} | revision=${revision} | compiler=${definition.compilerVersion}`;
  if (!css.startsWith(`/* DailyNews Theme | ${header}`)) {
    throw new ThemeServiceError("theme", `Theme Revision 编译产物无效：${themeId}@${revision}`);
  }
  return { definition, relativeCssPath: `/themes/compiled/${themeId}/${revision}.css` };
}

async function validateActive(reader) {
  const active = await reader.readActive();
  if (!active) return null;
  validateActiveThemePointer(active, SUPPORTED_THEME_COMPILER_VERSIONS);
  const { definition } = await loadRevision(reader, active.themeId, active.revision);
  if (
    definition.id !== active.themeId
    || definition.revision !== active.revision
    || definition.compilerVersion !== active.compilerVersion
  ) {
    throw new ThemeServiceError("active", "与指向的 Definition 元数据不一致");
  }
  return active;
}

async function validateConfigured(reader) {
  const config = await reader.readSelection();
  const homeActiveTheme = config?.schemaVersion === 2 && config.mode === "inherit"
    ? await reader.readHomeActiveTheme()
    : null;
  const selection = resolveThemeSelection(config, { homeActiveTheme });
  await loadRevision(reader, selection.activeTheme.id, selection.activeTheme.revision);
  const active = await validateActive(reader);
  if (!active) throw new ThemeServiceError("active", "不存在，无法应用 config/theme.json");
  return assertActiveMatchesSelection(active, selection);
}

export function createThemeApplicationService(storage) {
  requireThemeStorage(storage);
  return Object.freeze({
    async preview(input) {
      const { candidate, resolved, usesSiteAccent } = input;
      const { candidateHash, inputHash } = inputHashes(candidate, resolved, usesSiteAccent);
      const definition = createThemeDefinition(resolved, 0, { usesSiteAccent });
      const css = compileThemeCss(resolved, 0, { usesSiteAccent });
      const manifest = {
        ...createThemeManifest(definition, `/themes/previews/${candidate.id}.css`, candidateHash),
        status: "preview-ready",
        inputHash,
        definition,
      };
      const previous = await storage.readPreview(candidate.id);
      const unchanged = previous?.manifest?.inputHash === inputHash
        && previous.manifest.compilerVersion === THEME_COMPILER_VERSION
        && previous.css !== null
        && contentHash(previous.css) === contentHash(css);
      if (!unchanged) await storage.writePreview(candidate.id, { manifest, css });
      return {
        result: unchanged ? "unchanged" : "preview-ready",
        themeId: candidate.id,
        candidateHash,
      };
    },

    async activate(input) {
      const { candidate, resolved, usesSiteAccent } = input;
      const { candidateHash, inputHash } = inputHashes(candidate, resolved, usesSiteAccent);
      const preview = await storage.readPreview(candidate.id);
      if (
        !preview?.manifest
        || preview.manifest.candidateHash !== candidateHash
        || preview.manifest.inputHash !== inputHash
        || preview.manifest.compilerVersion !== THEME_COMPILER_VERSION
      ) {
        throw new ThemeServiceError("preview", "预览不存在、已过期或与当前候选不一致，请重新运行 process-theme");
      }
      return storage.withWriteTransaction(async (transaction) => {
        requireThemeWriteTransaction(transaction);
        const active = await validateConfigured(transaction);
        const activeDefinition = active
          ? (await loadRevision(transaction, active.themeId, active.revision)).definition
          : null;
        const planned = createThemeDefinition(resolved, 0, { usesSiteAccent });
        if (active?.themeId === candidate.id && sameThemeDefinition(activeDefinition, planned)) {
          return { result: "unchanged", themeId: candidate.id, revision: active.revision };
        }
        const revision = nextThemeRevision(await transaction.listRevisions(candidate.id));
        const definition = createThemeDefinition(resolved, revision, { usesSiteAccent });
        const relativeCssPath = `/themes/compiled/${candidate.id}/${revision}.css`;
        const css = compileThemeCss(resolved, revision, { usesSiteAccent });
        const nextActive = {
          ...createThemeManifest(definition, relativeCssPath, candidateHash),
          previous: active ? { themeId: active.themeId, revision: active.revision } : null,
        };
        await transaction.commit({
          revision: { themeId: candidate.id, revision, definition, css },
          selection: createOverrideThemeConfig(candidate.id, revision),
          active: nextActive,
        });
        return { result: "activated", themeId: candidate.id, revision, previous: nextActive.previous };
      });
    },

    async list() {
      const active = await validateConfigured(storage);
      const themes = [];
      for (const themeId of await storage.listThemeIds()) {
        const revisions = await storage.listRevisions(themeId);
        if (revisions.length === 0) continue;
        const latestRevision = revisions.at(-1);
        const { definition } = await loadRevision(storage, themeId, latestRevision);
        for (const revision of revisions.slice(0, -1)) await loadRevision(storage, themeId, revision);
        themes.push({
          id: definition.id,
          name: definition.name,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          latestRevision,
          revisions,
          activeRevision: active.themeId === definition.id ? active.revision : null,
        });
      }
      return { activeTheme: { id: active.themeId, revision: active.revision }, themes };
    },

    switch(input) {
      return storage.withWriteTransaction(async (transaction) => {
        requireThemeWriteTransaction(transaction);
        requireThemeId(input.themeId);
        const active = await validateConfigured(transaction);
        const revisions = await transaction.listRevisions(input.themeId);
        const revision = input.revision ?? revisions.at(-1);
        if (revision === undefined) {
          throw new ThemeServiceError("theme", `Theme Revision 不存在：${input.themeId}`);
        }
        const { definition, relativeCssPath } = await loadRevision(transaction, input.themeId, revision);
        if (active.themeId === input.themeId && active.revision === revision) {
          return { result: "unchanged", themeId: input.themeId, revision };
        }
        const nextActive = {
          ...createThemeManifest(definition, relativeCssPath, null),
          previous: { themeId: active.themeId, revision: active.revision },
        };
        await transaction.commit({
          selection: createOverrideThemeConfig(input.themeId, revision),
          active: nextActive,
        });
        return {
          result: "switched",
          themeId: input.themeId,
          revision,
          previous: nextActive.previous,
        };
      });
    },

    inherit() {
      return storage.withWriteTransaction(async (transaction) => {
        requireThemeWriteTransaction(transaction);
        const current = await transaction.readSelection();
        if (current?.schemaVersion === 2 && current.mode === "inherit") {
          await validateConfigured(transaction);
          return { result: "unchanged", mode: "inherit" };
        }
        const homeActiveTheme = await transaction.readHomeActiveTheme();
        const selection = resolveThemeSelection(
          { schemaVersion: 2, mode: "inherit" },
          { homeActiveTheme },
        );
        const { definition, relativeCssPath } = await loadRevision(
          transaction,
          selection.activeTheme.id,
          selection.activeTheme.revision,
        );
        const active = createThemeManifest(definition, relativeCssPath, null);
        await transaction.commit({ selection: { schemaVersion: 2, mode: "inherit" }, active });
        return {
          result: "inherited",
          mode: "inherit",
          themeId: active.themeId,
          revision: active.revision,
        };
      });
    },

    rollback() {
      return storage.withWriteTransaction(async (transaction) => {
        requireThemeWriteTransaction(transaction);
        const active = await validateConfigured(transaction);
        if (!active.previous) throw new ThemeServiceError("rollback", "当前主题没有可回滚版本");
        const target = active.previous;
        const { definition, relativeCssPath } = await loadRevision(
          transaction,
          target.themeId,
          target.revision,
        );
        const nextActive = {
          ...createThemeManifest(definition, relativeCssPath, null),
          previous: { themeId: active.themeId, revision: active.revision },
        };
        await transaction.commit({
          selection: createOverrideThemeConfig(target.themeId, target.revision),
          active: nextActive,
        });
        return {
          result: "rolled-back",
          themeId: target.themeId,
          revision: target.revision,
          previous: nextActive.previous,
        };
      });
    },

    loadRevision(themeId, revision) {
      return loadRevision(storage, themeId, revision);
    },
    validateActive() {
      return validateActive(storage);
    },
    validateConfigured() {
      return validateConfigured(storage);
    },
  });
}
