import { realpath } from "node:fs/promises";
import path from "node:path";
import { createDailyApplicationService } from "./application/daily-service.js";
import { DailyDomainError, planIssue } from "./domain/daily.js";
import { loadPublicationContext } from "./publications.js";
import { createFileDailyStorage } from "./storage/file-daily.js";
import { validateCandidate, validateIssue, validateSite } from "./validation.js";

export const PipelineError = DailyDomainError;
export { planIssue };

export function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
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

  const candidate = await validateCandidate(resolvedCandidate, context.rootDir);
  const site = await validateSite(context.rootDir, context.publicationDir);
  const { priorityLimits } = site;
  const today = options.today ?? shanghaiDate();
  if (candidate.date > today) {
    throw new PipelineError(candidate.date, "date", "不能处理未来日期");
  }
  if (candidate.date < today && !options.allowHistory) {
    throw new PipelineError(
      candidate.date,
      "date",
      "历史日期必须显式使用 --allow-history",
      "authorization_required",
    );
  }

  const mode = options.mode ?? "update";
  if (mode !== "update" && mode !== "replace") {
    throw new PipelineError(candidate.date, "mode", "只能是 update 或 replace");
  }
  if (mode === "replace" && !options.allowReplace) {
    throw new PipelineError(
      candidate.date,
      "mode",
      "replace 必须显式使用 --allow-replace",
      "authorization_required",
    );
  }

  const storage = createFileDailyStorage({
    dataDir: context.dataDir,
    validateIssue: (filePath, expectedDate) => (
      validateIssue(filePath, expectedDate, context.rootDir)
    ),
  });
  return createDailyApplicationService(storage).submit({
    candidate,
    publicationId,
    priorityLimits,
    mode,
  });
}
