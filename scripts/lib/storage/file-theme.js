import { open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { commitStages, readJsonIfPresent, stageFile, stageJson } from "./atomic-file.js";

const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireThemeKey(themeId, revision) {
  if (!THEME_ID_PATTERN.test(themeId ?? "")) {
    throw new Error("themeId 只能包含小写字母、数字和连字符");
  }
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
    throw new Error("revision 必须是大于等于 1 的整数");
  }
}

async function readTextIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return await readJsonIfPresent(filePath);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${filePath} 不是合法 JSON`);
    throw error;
  }
}

export async function acquireThemeFileLock(rootDir) {
  const lockPath = path.join(rootDir, "themes", ".theme.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "EEXIST") throw new Error("lock 已有主题写入流程正在执行");
    throw error;
  }
  await handle.close();
  return () => unlink(lockPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function createFileThemeStorage(options) {
  const { rootDir, storageRoot = rootDir } = options;
  const previewPaths = (themeId) => {
    requireThemeKey(themeId);
    return {
      manifest: path.join(rootDir, "themes", "previews", `${themeId}.json`),
      css: path.join(rootDir, "themes", "previews", `${themeId}.css`),
    };
  };
  const revisionPaths = (themeId, revision) => {
    requireThemeKey(themeId, revision);
    return {
      definition: path.join(rootDir, "themes", "definitions", themeId, `${revision}.json`),
      css: path.join(rootDir, "themes", "compiled", themeId, `${revision}.css`),
    };
  };

  const reads = {
    async readPreview(themeId) {
      const paths = previewPaths(themeId);
      const [manifest, css] = await Promise.all([readJson(paths.manifest), readTextIfPresent(paths.css)]);
      return manifest || css !== null ? { manifest, css } : null;
    },
    async listThemeIds() {
      const entries = await readdir(path.join(rootDir, "themes", "definitions"), { withFileTypes: true })
        .catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      return entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
    },
    async listRevisions(themeId) {
      requireThemeKey(themeId);
      const names = await readdir(path.join(rootDir, "themes", "definitions", themeId)).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      return names
        .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
        .filter(Boolean)
        .map(Number)
        .filter((revision) => Number.isInteger(revision) && revision >= 1)
        .sort((left, right) => left - right);
    },
    async readThemeRevision(themeId, revision) {
      const paths = revisionPaths(themeId, revision);
      const [definition, css] = await Promise.all([readJson(paths.definition), readTextIfPresent(paths.css)]);
      return definition && css !== null ? { definition, css } : null;
    },
    readSelection() {
      return readJson(path.join(storageRoot, "config", "theme.json"));
    },
    async readHomeActiveTheme() {
      return (await readJson(path.join(rootDir, "config", "home.json")))?.activeTheme ?? null;
    },
    readActive() {
      return readJson(path.join(storageRoot, "themes", "active.json"));
    },
  };

  async function commit(changes) {
    const stages = [];
    try {
      if (changes.revision) {
        const paths = revisionPaths(changes.revision.themeId, changes.revision.revision);
        stages.push(await stageJson(paths.definition, changes.revision.definition));
        stages.push(await stageFile(paths.css, changes.revision.css));
      }
      if (changes.selection) {
        stages.push(await stageJson(path.join(storageRoot, "config", "theme.json"), changes.selection));
      }
      if (changes.active) {
        stages.push(await stageJson(path.join(storageRoot, "themes", "active.json"), changes.active));
      }
      await commitStages(stages, { rollbackErrorMessage: "主题事务失败且回滚不完整" });
    } catch (error) {
      await Promise.all(stages.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
      throw error;
    }
  }

  return Object.freeze({
    ...reads,
    previewLocator(themeId) {
      return previewPaths(themeId).manifest;
    },
    async writePreview(themeId, preview) {
      const paths = previewPaths(themeId);
      const stages = [];
      try {
        stages.push(await stageFile(paths.css, preview.css));
        stages.push(await stageJson(paths.manifest, preview.manifest));
        await commitStages(stages, { rollbackErrorMessage: "主题预览事务失败且回滚不完整" });
      } catch (error) {
        await Promise.all(stages.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
        throw error;
      }
    },
    async withWriteTransaction(work) {
      const release = await acquireThemeFileLock(rootDir);
      try {
        return await work({ ...reads, commit });
      } finally {
        await release();
      }
    },
  });
}
