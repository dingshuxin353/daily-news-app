import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonIfPresent(filePath, options = {}) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (options.allowInvalid && error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function stageFile(targetPath, source) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  const previous = await readFile(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  await writeFile(temporaryPath, source, { flag: "wx" });
  return { targetPath, temporaryPath, previous };
}

export function stageJson(targetPath, value) {
  return stageFile(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function restoreStage(stage) {
  if (stage.previous === null) {
    await unlink(stage.targetPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  const restorePath = `${stage.targetPath}.${randomUUID()}.restore`;
  await writeFile(restorePath, stage.previous, { flag: "wx" });
  await rename(restorePath, stage.targetPath);
}

export async function commitStages(stages, options = {}) {
  const committed = [];
  try {
    for (const stage of stages) {
      await rename(stage.temporaryPath, stage.targetPath);
      committed.push(stage);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const stage of committed.reverse()) {
      try {
        await restoreStage(stage);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        options.rollbackErrorMessage ?? "事务提交失败且回滚不完整",
      );
    }
    throw error;
  } finally {
    await Promise.all(stages.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
  }
}
