import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import { TodoError } from "../domain/todo-validation.js";
import { commitStages, readJsonIfPresent, stageJson } from "./atomic-file.js";

async function acquireTodoLock(dataDir) {
  const lockPath = path.join(dataDir, ".locks", "todo.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "EEXIST") throw new TodoError("lock", "已有 Todo 写入流程正在执行");
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  await handle.close();
  return async () => {
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
}

export function createFileTodoStorage(options) {
  const { dataDir, statePath, readState } = options;
  return Object.freeze({
    async withWriteTransaction(candidateId, work) {
      const releaseLock = await acquireTodoLock(dataDir);
      const submissionPath = path.join(dataDir, "submissions", `${candidateId}.json`);
      const transaction = {
        async readSubmission() {
          const metadata = await lstat(submissionPath).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (metadata?.isSymbolicLink() || (metadata && !metadata.isFile())) {
            throw new TodoError("submission", "必须是 Todo 数据目录内的普通文件");
          }
          try {
            return await readJsonIfPresent(submissionPath);
          } catch (error) {
            if (error instanceof SyntaxError) throw new TodoError(submissionPath, "不是合法 JSON");
            throw error;
          }
        },
        readState,
        async commit(changes) {
          const stages = [];
          if (changes.state !== undefined) stages.push(await stageJson(statePath, changes.state));
          if (changes.submission !== undefined) stages.push(await stageJson(submissionPath, changes.submission));
          await commitStages(stages, { rollbackErrorMessage: "Todo 事务提交失败且回滚不完整" });
        },
      };
      try {
        return await work(transaction);
      } finally {
        await releaseLock();
      }
    },
  });
}
