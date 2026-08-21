import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { compileIssue } from "../scripts/lib/compiler.js";

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function createTestIssue(
  date = "2026-08-19",
  priorities = ["lead", "important", "important", "normal", "normal", "normal"],
) {
  const priorDate = previousDate(date);
  return {
    schemaVersion: 1,
    date,
    generatedAt: `${date}T08:00:00+08:00`,
    coverage: {
      start: `${priorDate}T08:00:00+08:00`,
      end: `${date}T08:00:00+08:00`,
    },
    revision: 1,
    items: priorities.map((priority, index) => {
      const number = index + 1;
      const sources = [{
        name: `测试来源 ${number}`,
        url: `https://example.com/${date}/item-${number}`,
      }];
      if (index === 0) {
        sources.push({
          name: "补充测试来源",
          url: `https://example.org/${date}/item-${number}`,
        });
      }
      return {
        id: `test-item-${number}`,
        title: `测试标题 ${number}`,
        brief: `测试短摘要 ${number}`,
        summary: `测试完整摘要 ${number}`,
        category: index === priorities.length - 1 ? undefined : "测试",
        editorial: {
          priority,
          selectionReason: `测试选择理由 ${number}`,
        },
        sources,
      };
    }),
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function seedTestData(rootDir) {
  const dataDir = path.join(rootDir, "data");
  const issueDir = path.join(dataDir, "issues");
  const compiledDir = path.join(dataDir, "compiled");
  await Promise.all([
    mkdir(path.join(dataDir, "candidates"), { recursive: true }),
    mkdir(issueDir, { recursive: true }),
    mkdir(compiledDir, { recursive: true }),
  ]);

  const issues = [
    createTestIssue("2026-08-19"),
    createTestIssue("2026-08-18", ["normal", "normal"]),
  ];
  for (const issue of issues) {
    await writeJson(path.join(issueDir, `${issue.date}.json`), issue);
    await writeJson(path.join(compiledDir, `${issue.date}.json`), compileIssue(issue).compiled);
  }
  await writeJson(path.join(dataDir, "index.json"), {
    latest: "2026-08-19",
    dates: ["2026-08-19", "2026-08-18"],
  });
}
