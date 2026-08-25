import { compileIssue, validateCompiled } from "../compiler.js";
import { DailyDomainError, planIssue } from "../domain/daily.js";
import { sameValue } from "../domain/value.js";
import { requireDailyStorage, requireDailyWriteTransaction } from "../storage/ports.js";

function compiledIsCurrent(issue, compiled, priorityLimits) {
  if (!compiled) return false;
  try {
    validateCompiled(issue, compiled, issue.date, priorityLimits);
    return true;
  } catch {
    return false;
  }
}

function buildIndex(dates, date) {
  const unique = new Set(dates);
  unique.add(date);
  const sorted = [...unique].sort((left, right) => right.localeCompare(left));
  return { latest: sorted[0], dates: sorted };
}

export function createDailyApplicationService(storage) {
  requireDailyStorage(storage);
  return Object.freeze({
    async submit(input) {
      const { candidate, publicationId, priorityLimits } = input;
      const mode = input.mode ?? "update";
      return storage.withWriteTransaction(candidate.date, async (transaction) => {
        requireDailyWriteTransaction(transaction);
        const existingIssue = await transaction.readIssue();
        if (existingIssue?.schemaVersion === 2 && candidate.schemaVersion === 1) {
          throw new DailyDomainError(
            candidate.date,
            "schemaVersion",
            "Schema 1 Candidate 不能更新 Schema 2 Issue",
          );
        }

        const plan = planIssue(candidate, existingIssue, mode);
        const nextIndex = buildIndex(await transaction.listIssueDates(), candidate.date);
        const currentIndex = await transaction.readIndex();
        let warnings = [];

        if (plan.result === "unchanged") {
          const changes = {};
          const repaired = [];
          const currentCompiled = await transaction.readCompiled();
          if (!compiledIsCurrent(plan.issue, currentCompiled, priorityLimits)) {
            const compiledResult = compileIssue(plan.issue, candidate.date, priorityLimits);
            changes.compiled = compiledResult.compiled;
            warnings = compiledResult.warnings;
            repaired.push("compiled");
          }
          if (!sameValue(currentIndex, nextIndex)) {
            changes.index = nextIndex;
            repaired.push("index");
          }
          if (repaired.length > 0) await transaction.commit(changes);
          return {
            result: "unchanged",
            publicationId,
            date: candidate.date,
            revision: plan.issue.revision,
            repaired,
            warnings,
          };
        }

        const compiledResult = compileIssue(plan.issue, candidate.date, priorityLimits);
        warnings = compiledResult.warnings;
        await transaction.commit({
          issue: plan.issue,
          compiled: compiledResult.compiled,
          index: nextIndex,
        });
        return {
          result: plan.result,
          publicationId,
          date: candidate.date,
          revision: plan.issue.revision,
          mode,
          warnings,
        };
      });
    },
  });
}
