import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { ensureTodoData, processTodoCandidate } from "./todo-pipeline.js";

export function todoLogRecord(status) {
  return {
    candidateId: status.candidateId,
    revision: status.revision,
    operationCount: status.operationCount,
    result: status.result,
  };
}

export async function startTodoHost(rootDir, options = {}) {
  const { dataDir } = await ensureTodoData(rootDir);
  const candidateDir = path.join(dataDir, "candidates");
  const reportError = options.onError ?? ((error) => console.error(error.message));
  const reportStatus = options.onStatus ?? ((status) => console.log(JSON.stringify(todoLogRecord(status))));
  let queue = Promise.resolve();
  const enqueue = (candidatePath) => {
    queue = queue.then(async () => {
      const status = await processTodoCandidate(rootDir, candidatePath, options);
      await options.rebuild?.(status);
      reportStatus(status);
      return status;
    }).catch(reportError);
    return queue;
  };

  const seen = new Map();
  async function signature(candidatePath) {
    try {
      const metadata = await stat(candidatePath);
      return metadata.isFile() ? `${metadata.size}:${metadata.mtimeMs}` : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  for (const name of (await readdir(candidateDir)).sort()) {
    if (!name.endsWith(".json")) continue;
    const candidatePath = path.join(candidateDir, name);
    seen.set(candidatePath, await signature(candidatePath));
    enqueue(candidatePath);
  }
  await queue;

  if (options.watch === false) return { close() {} };
  const timers = new Map();
  let closed = false;
  const schedule = (candidatePath, delay = options.debounceMs ?? 250) => {
    if (closed) return;
    clearTimeout(timers.get(candidatePath));
    timers.set(candidatePath, setTimeout(async () => {
      try {
        timers.delete(candidatePath);
        const current = await signature(candidatePath);
        if (!current || current === seen.get(candidatePath)) return;
        seen.set(candidatePath, current);
        enqueue(candidatePath);
      } catch (error) {
        reportError(error);
      }
    }, delay));
  };
  const watcher = watch(candidateDir, (_event, filename) => {
    if (filename?.endsWith(".json")) schedule(path.join(candidateDir, filename));
  });
  const poll = setInterval(async () => {
    if (closed) return;
    try {
      for (const name of await readdir(candidateDir)) {
        if (name.endsWith(".json")) schedule(path.join(candidateDir, name), 0);
      }
    } catch (error) {
      reportError(error);
    }
  }, options.pollMs ?? 1000);
  poll.unref();
  return {
    close() {
      closed = true;
      clearInterval(poll);
      for (const timer of timers.values()) clearTimeout(timer);
      watcher.close();
    },
  };
}
