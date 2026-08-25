import { mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { DailyDomainError } from "../domain/daily.js";
import { commitStages, readJsonIfPresent, stageJson } from "./atomic-file.js";

async function acquireDateLock(dataDir, date) {
  const lockDir = path.join(dataDir, ".locks");
  const lockPath = path.join(lockDir, `${date}.lock`);
  await mkdir(lockDir, { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "EEXIST") {
      throw new DailyDomainError(date, "lock", "同日期已有写入流程正在执行");
    }
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

async function listIssueDates(dataDir) {
  const names = await readdir(path.join(dataDir, "issues")).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, -5));
}

export function createFileDailyStorage(options) {
  const { dataDir, validateIssue } = options;
  return Object.freeze({
    async withWriteTransaction(date, work) {
      const releaseLock = await acquireDateLock(dataDir, date);
      const issuePath = path.join(dataDir, "issues", `${date}.json`);
      const compiledPath = path.join(dataDir, "compiled", `${date}.json`);
      const indexPath = path.join(dataDir, "index.json");
      const transaction = {
        async readIssue() {
          const issue = await readJsonIfPresent(issuePath);
          if (issue && validateIssue) await validateIssue(issuePath, date);
          return issue;
        },
        readCompiled() {
          return readJsonIfPresent(compiledPath, { allowInvalid: true });
        },
        readIndex() {
          return readJsonIfPresent(indexPath, { allowInvalid: true });
        },
        listIssueDates() {
          return listIssueDates(dataDir);
        },
        async commit(changes) {
          const stages = [];
          try {
            if (changes.issue !== undefined) {
              const issueStage = await stageJson(issuePath, changes.issue);
              stages.push(issueStage);
              if (validateIssue) await validateIssue(issueStage.temporaryPath, date);
            }
            if (changes.compiled !== undefined) stages.push(await stageJson(compiledPath, changes.compiled));
            if (changes.index !== undefined) stages.push(await stageJson(indexPath, changes.index));
            await commitStages(stages);
          } catch (error) {
            await Promise.all(stages.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
            throw error;
          }
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
