import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildSite } from "./site-builder.js";
import { processCandidate, shanghaiDate } from "./pipeline.js";
import { loadPublicationRegistry } from "./publications.js";

const candidateNamePattern = /^(\d{4}-\d{2}-\d{2})\.json$/;

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, filePath);
}

async function recordStatus(context, status, onStatus) {
  const statusDir = path.join(context.dataDir, "submissions");
  if (status.date) {
    await writeJsonAtomic(path.join(statusDir, `${status.date}.json`), status);
  }
  await writeJsonAtomic(path.join(statusDir, "latest.json"), status);
  await onStatus?.(status);
  return status;
}

function safeReason(error, rootDir) {
  return String(error.message ?? "Candidate 处理失败").replaceAll(rootDir, ".");
}

export async function processCandidateFile(rootDir, context, candidatePath, options = {}) {
  const filename = path.basename(candidatePath);
  const date = candidateNamePattern.exec(filename)?.[1] ?? null;
  const today = options.today ?? shanghaiDate();
  const base = { publicationId: context.publicationId, date };

  await recordStatus(context, { ...base, result: "candidate_ready" }, options.onStatus);
  if (!date) {
    const rejected = {
      ...base,
      result: "rejected",
      field: "candidate",
      reason: "Candidate 文件名必须是 YYYY-MM-DD.json",
    };
    await recordStatus(context, rejected, options.onStatus);
    await options.rebuild?.();
    return rejected;
  }
  if (date < today) {
    const authorization = {
      ...base,
      result: "authorization_required",
      field: "date",
      reason: "历史日期需要显式授权，宿主未自动处理",
    };
    await recordStatus(context, authorization, options.onStatus);
    await options.rebuild?.();
    return authorization;
  }
  if (date > today) {
    const rejected = {
      ...base,
      result: "rejected",
      field: "date",
      reason: "不能自动处理未来日期",
    };
    await recordStatus(context, rejected, options.onStatus);
    await options.rebuild?.();
    return rejected;
  }

  await recordStatus(context, { ...base, result: "processing" }, options.onStatus);
  let finalStatus;
  try {
    const writer = await processCandidate(
      rootDir,
      context.publicationId,
      candidatePath,
      { today, mode: "update" },
    );
    finalStatus = {
      ...base,
      result: "published",
      writerResult: writer.result,
      revision: writer.revision,
      warnings: writer.warnings,
      pageUrl: `/p/${context.publicationId}/?date=${date}`,
    };
  } catch (error) {
    finalStatus = {
      ...base,
      result: error.result ?? "rejected",
      field: error.field ?? null,
      reason: safeReason(error, rootDir),
    };
  }
  await recordStatus(context, finalStatus, options.onStatus);
  await options.rebuild?.();
  return finalStatus;
}

export async function startCandidateHost(rootDir, options = {}) {
  const registry = await loadPublicationRegistry(rootDir);
  const rebuild = options.rebuild ?? (() => buildSite(rootDir));
  const reportError = options.onError ?? ((error) => console.error(error.message));
  let queue = Promise.resolve();
  const enqueue = (context, candidatePath) => {
    queue = queue
      .then(() => processCandidateFile(rootDir, context, candidatePath, {
        today: options.today,
        onStatus: options.onStatus,
        rebuild,
      }))
      .catch(reportError);
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

  for (const context of registry.publications) {
    const candidateDir = path.join(context.dataDir, "candidates");
    const names = await readdir(candidateDir);
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const candidatePath = path.join(candidateDir, name);
      seen.set(candidatePath, await signature(candidatePath));
      enqueue(context, candidatePath);
    }
  }
  await queue;

  if (options.watch === false) return { close() {} };
  const watchers = [];
  const timers = new Map();
  let closed = false;
  const schedule = (context, candidatePath, delay = options.debounceMs ?? 250) => {
    if (closed) return;
    clearTimeout(timers.get(candidatePath));
    timers.set(candidatePath, setTimeout(async () => {
      try {
        timers.delete(candidatePath);
        const current = await signature(candidatePath);
        if (!current || current === seen.get(candidatePath)) return;
        seen.set(candidatePath, current);
        enqueue(context, candidatePath);
      } catch (error) {
        reportError(error);
      }
    }, delay));
  };
  for (const context of registry.publications) {
    const candidateDir = path.join(context.dataDir, "candidates");
    watchers.push(watch(candidateDir, (_event, filename) => {
      if (!filename?.endsWith(".json")) return;
      const candidatePath = path.join(candidateDir, filename);
      schedule(context, candidatePath);
    }));
  }
  const poll = setInterval(async () => {
    if (closed) return;
    try {
      for (const context of registry.publications) {
        const candidateDir = path.join(context.dataDir, "candidates");
        for (const name of await readdir(candidateDir)) {
          if (name.endsWith(".json")) schedule(context, path.join(candidateDir, name), 0);
        }
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
      for (const watcher of watchers) watcher.close();
    },
  };
}
