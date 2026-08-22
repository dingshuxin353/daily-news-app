import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { compileIssue, validateCompiled } from "./compiler.js";
import { loadPublicationContext } from "./publications.js";
import { validateCandidate, validateIssue, validateSite } from "./validation.js";

export class PipelineError extends Error {
  constructor(date, field, message) {
    super(`${date}: ${field} ${message}`);
    this.name = "PipelineError";
    this.date = date;
    this.field = field;
  }
}

function clone(value) {
  return structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function businessContent(issue) {
  return {
    schemaVersion: issue.schemaVersion,
    date: issue.date,
    coverage: issue.coverage,
    items: issue.items,
  };
}

function mergeSources(candidateSources, existingSources) {
  const urls = new Set(candidateSources.map(({ url }) => url));
  return [
    ...candidateSources.map(clone),
    ...existingSources.filter(({ url }) => !urls.has(url)).map(clone),
  ];
}

export function planIssue(candidate, existingIssue, mode = "update") {
  if (mode !== "update" && mode !== "replace") {
    throw new PipelineError(candidate.date, "mode", "只能是 update 或 replace");
  }

  if (!existingIssue) {
    return {
      result: "created",
      issue: {
        schemaVersion: candidate.schemaVersion,
        date: candidate.date,
        generatedAt: candidate.generatedAt,
        coverage: clone(candidate.coverage),
        revision: 1,
        items: candidate.items.map(clone),
      },
    };
  }

  if (!sameValue(existingIssue.coverage, candidate.coverage)) {
    throw new PipelineError(candidate.date, "coverage", "与首次创建时的固定采集窗口不一致");
  }

  const claimedExisting = new Set();
  const plannedItems = candidate.items.map((candidateItem) => {
    const candidateUrls = new Set(candidateItem.sources.map(({ url }) => url));
    const matched = new Set();
    existingIssue.items.forEach((existingItem, index) => {
      if (existingItem.id === candidateItem.id) matched.add(index);
      if (existingItem.sources.some(({ url }) => candidateUrls.has(url))) matched.add(index);
    });

    if (matched.size > 1) {
      throw new PipelineError(
        candidate.date,
        `items.${candidateItem.id}`,
        "ID 与来源 URL 命中了多个已有条目，无法确定性合并",
      );
    }

    const [matchedIndex] = matched;
    if (matchedIndex === undefined) return clone(candidateItem);
    if (claimedExisting.has(matchedIndex)) {
      throw new PipelineError(
        candidate.date,
        `items.${candidateItem.id}`,
        "与另一条候选命中了同一个已有条目",
      );
    }
    claimedExisting.add(matchedIndex);
    const existingItem = existingIssue.items[matchedIndex];
    return {
      ...clone(candidateItem),
      id: existingItem.id,
      sources: mergeSources(candidateItem.sources, existingItem.sources),
    };
  });

  if (mode === "update") {
    existingIssue.items.forEach((item, index) => {
      if (!claimedExisting.has(index)) plannedItems.push(clone(item));
    });
  }

  const nextIssue = {
    schemaVersion: candidate.schemaVersion,
    date: candidate.date,
    generatedAt: candidate.generatedAt,
    coverage: clone(existingIssue.coverage),
    revision: existingIssue.revision + 1,
    items: plannedItems,
  };

  if (sameValue(businessContent(existingIssue), businessContent(nextIssue))) {
    return { result: "unchanged", issue: clone(existingIssue) };
  }
  return { result: "updated", issue: nextIssue };
}

function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function readJsonIfPresent(filePath, allowInvalid = false) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (allowInvalid && error instanceof SyntaxError) return null;
    throw error;
  }
}

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
      throw new PipelineError(date, "lock", "同日期已有写入流程正在执行");
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

async function issueIndex(dataDir, date) {
  const issuesDir = path.join(dataDir, "issues");
  const names = await readdir(issuesDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const dates = new Set(
    names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => name.slice(0, -5)),
  );
  dates.add(date);
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  return { latest: sorted[0], dates: sorted };
}

async function stageJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  const previous = await readFile(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  return { targetPath, temporaryPath, previous };
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

async function commitStages(stages) {
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
      throw new AggregateError([error, ...rollbackErrors], "事务提交失败且回滚不完整");
    }
    throw error;
  } finally {
    await Promise.all(stages.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
  }
}

function compiledIsCurrent(issue, compiled, filePath, priorityLimits) {
  if (!compiled) return false;
  try {
    validateCompiled(issue, compiled, filePath, priorityLimits);
    return true;
  } catch {
    return false;
  }
}

export async function processCandidate(rootDir, publicationId, candidatePath, options = {}) {
  const context = await loadPublicationContext(rootDir, publicationId);
  const resolvedCandidate = await realpath(path.resolve(candidatePath));
  const candidateDir = await realpath(path.join(context.dataDir, "candidates"));
  if (path.dirname(resolvedCandidate) !== candidateDir) {
    throw new PipelineError(
      "unknown",
      "candidate",
      `必须位于 Publication ${publicationId} 的 data/candidates/ 目录`,
    );
  }

  const candidate = await validateCandidate(resolvedCandidate);
  const site = await validateSite(context.rootDir, context.publicationDir);
  const { priorityLimits } = site;
  const today = options.today ?? shanghaiDate();
  if (candidate.date > today) {
    throw new PipelineError(candidate.date, "date", "不能处理未来日期");
  }
  if (candidate.date < today && !options.allowHistory) {
    throw new PipelineError(candidate.date, "date", "历史日期必须显式使用 --allow-history");
  }

  const mode = options.mode ?? "update";
  if (mode !== "update" && mode !== "replace") {
    throw new PipelineError(candidate.date, "mode", "只能是 update 或 replace");
  }

  const releaseLock = await acquireDateLock(context.dataDir, candidate.date);
  try {
    const issuePath = path.join(context.dataDir, "issues", `${candidate.date}.json`);
    const compiledPath = path.join(context.dataDir, "compiled", `${candidate.date}.json`);
    const indexPath = path.join(context.dataDir, "index.json");
    const existingIssue = await readJsonIfPresent(issuePath);
    if (existingIssue) await validateIssue(issuePath);
    const plan = planIssue(candidate, existingIssue, mode);
    const nextIndex = await issueIndex(context.dataDir, candidate.date);
    const currentIndex = await readJsonIfPresent(indexPath, true);
    const stages = [];
    let compiled;
    let warnings = [];
    const repaired = [];

    if (plan.result === "unchanged") {
      const currentCompiled = await readJsonIfPresent(compiledPath, true);
      if (!compiledIsCurrent(plan.issue, currentCompiled, compiledPath, priorityLimits)) {
        ({ compiled, warnings } = compileIssue(plan.issue, issuePath, priorityLimits));
        stages.push(await stageJson(compiledPath, compiled));
        repaired.push("compiled");
      }
      if (!sameValue(currentIndex, nextIndex)) {
        stages.push(await stageJson(indexPath, nextIndex));
        repaired.push("index");
      }
      if (stages.length > 0) await commitStages(stages);
      return {
        result: "unchanged",
        publicationId,
        date: candidate.date,
        revision: plan.issue.revision,
        repaired,
        warnings,
      };
    }

    const issueStage = await stageJson(issuePath, plan.issue);
    stages.push(issueStage);
    try {
      await validateIssue(issueStage.temporaryPath, candidate.date);
      ({ compiled, warnings } = compileIssue(plan.issue, issuePath, priorityLimits));
      stages.push(await stageJson(compiledPath, compiled));
      stages.push(await stageJson(indexPath, nextIndex));
      await commitStages(stages);
    } catch (error) {
      await Promise.all(stages.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => {})));
      throw error;
    }

    return {
      result: plan.result,
      publicationId,
      date: candidate.date,
      revision: plan.issue.revision,
      mode,
      warnings,
    };
  } finally {
    await releaseLock();
  }
}
