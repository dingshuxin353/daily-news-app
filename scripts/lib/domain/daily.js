import { cloneValue, sameValue } from "./value.js";

export class DailyDomainError extends Error {
  constructor(date, field, message, result = "rejected") {
    super(`${date}: ${field} ${message}`);
    this.name = "DailyDomainError";
    this.date = date;
    this.field = field;
    this.result = result;
  }
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
    ...candidateSources.map(cloneValue),
    ...existingSources.filter(({ url }) => !urls.has(url)).map(cloneValue),
  ];
}

export function planIssue(candidate, existingIssue, mode = "update") {
  if (mode !== "update" && mode !== "replace") {
    throw new DailyDomainError(candidate.date, "mode", "只能是 update 或 replace");
  }

  if (!existingIssue) {
    return {
      result: "created",
      issue: {
        schemaVersion: candidate.schemaVersion,
        date: candidate.date,
        generatedAt: candidate.generatedAt,
        coverage: cloneValue(candidate.coverage),
        revision: 1,
        items: candidate.items.map(cloneValue),
      },
    };
  }

  if (!sameValue(existingIssue.coverage, candidate.coverage)) {
    throw new DailyDomainError(candidate.date, "coverage", "与首次创建时的固定采集窗口不一致");
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
      throw new DailyDomainError(
        candidate.date,
        `items.${candidateItem.id}`,
        "ID 与来源 URL 命中了多个已有条目，无法确定性合并",
      );
    }

    const [matchedIndex] = matched;
    if (matchedIndex === undefined) return cloneValue(candidateItem);
    if (claimedExisting.has(matchedIndex)) {
      throw new DailyDomainError(
        candidate.date,
        `items.${candidateItem.id}`,
        "与另一条候选命中了同一个已有条目",
      );
    }
    claimedExisting.add(matchedIndex);
    const existingItem = existingIssue.items[matchedIndex];
    return {
      ...cloneValue(candidateItem),
      id: existingItem.id,
      sources: mergeSources(candidateItem.sources, existingItem.sources),
    };
  });

  if (mode === "update") {
    existingIssue.items.forEach((item, index) => {
      if (!claimedExisting.has(index)) plannedItems.push(cloneValue(item));
    });
  }

  const nextIssue = {
    schemaVersion: candidate.schemaVersion,
    date: candidate.date,
    generatedAt: candidate.generatedAt,
    coverage: cloneValue(existingIssue.coverage),
    revision: existingIssue.revision + 1,
    items: plannedItems,
  };

  if (sameValue(businessContent(existingIssue), businessContent(nextIssue))) {
    return { result: "unchanged", issue: cloneValue(existingIssue) };
  }
  return { result: "updated", issue: nextIssue };
}
