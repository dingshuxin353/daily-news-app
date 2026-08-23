import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { processCandidateFile, startCandidateHost } from "../scripts/lib/candidate-host.js";
import { loadPublicationRegistry } from "../scripts/lib/publications.js";
import { createTestIssue, seedTestData } from "../test-support/helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicationId = "ai-daily";

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-host-"));
  await cp(path.join(rootDir, "themes"), path.join(target, "themes"), { recursive: true });
  await mkdir(path.join(target, "config"), { recursive: true });
  await writeFile(path.join(target, "config", "publications.json"), JSON.stringify({
    schemaVersion: 1,
    defaultPublicationId: publicationId,
    publicationIds: [publicationId],
  }));
  const publication = path.join(target, "publications", publicationId);
  await mkdir(path.join(publication, "config"), { recursive: true });
  await mkdir(path.join(publication, "themes"), { recursive: true });
  await mkdir(path.join(publication, "data", "submissions"), { recursive: true });
  await cp(path.join(rootDir, "config", "site.json"), path.join(publication, "config", "site.json"));
  await cp(path.join(rootDir, "config", "theme.json"), path.join(publication, "config", "theme.json"));
  await cp(path.join(rootDir, "themes", "active.json"), path.join(publication, "themes", "active.json"));
  await seedTestData(publication);
  return { target, publication };
}

function candidateFromIssue(issue) {
  const { revision: _revision, ...candidate } = structuredClone(issue);
  return candidate;
}

async function writeCandidate(publication, candidate, source = null) {
  const candidatePath = path.join(publication, "data", "candidates", `${candidate.date}.json`);
  await writeFile(candidatePath, source ?? `${JSON.stringify(candidate, null, 2)}\n`);
  return candidatePath;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("宿主启动自动发布当天 Candidate，并在重复发现时保持 revision", async () => {
  const { target, publication } = await fixture();
  const candidate = candidateFromIssue(createTestIssue("2026-08-20"));
  await writeCandidate(publication, candidate);
  const transitions = [];
  let rebuilds = 0;

  await startCandidateHost(target, {
    watch: false,
    today: "2026-08-20",
    onStatus: (status) => transitions.push(status.result),
    rebuild: async () => { rebuilds += 1; },
  });

  const statusPath = path.join(publication, "data", "submissions", "2026-08-20.json");
  const firstStatus = await readJson(statusPath);
  assert.deepEqual(transitions, ["candidate_ready", "processing", "published"]);
  assert.equal(firstStatus.writerResult, "created");
  assert.equal(firstStatus.revision, 1);
  assert.equal(firstStatus.pageUrl, "/p/ai-daily/?date=2026-08-20");
  assert.equal(rebuilds, 1);

  await startCandidateHost(target, {
    watch: false,
    today: "2026-08-20",
    rebuild: async () => { rebuilds += 1; },
  });
  const repeatedStatus = await readJson(statusPath);
  const issue = await readJson(path.join(publication, "data", "issues", "2026-08-20.json"));
  assert.equal(repeatedStatus.writerResult, "unchanged");
  assert.equal(repeatedStatus.revision, 1);
  assert.equal(issue.revision, 1);
  assert.equal(rebuilds, 2);
});

test("宿主将历史 Candidate 标为 authorization_required，不改正式 Issue", async () => {
  const { target, publication } = await fixture();
  const registry = await loadPublicationRegistry(target);
  const context = registry.publications[0];
  const existingPath = path.join(publication, "data", "issues", "2026-08-18.json");
  const before = await readFile(existingPath, "utf8");
  const existing = JSON.parse(before);
  const candidatePath = await writeCandidate(publication, candidateFromIssue(existing));

  const status = await processCandidateFile(target, context, candidatePath, {
    today: "2026-08-20",
    rebuild: async () => {},
  });

  assert.equal(status.result, "authorization_required");
  assert.equal(await readFile(existingPath, "utf8"), before);
});

test("宿主拒绝无效 Candidate，且状态不暴露绝对项目路径", async () => {
  const { target, publication } = await fixture();
  const registry = await loadPublicationRegistry(target);
  const candidatePath = await writeCandidate(
    publication,
    { date: "2026-08-20" },
    "{ invalid",
  );

  const status = await processCandidateFile(target, registry.publications[0], candidatePath, {
    today: "2026-08-20",
    rebuild: async () => {},
  });

  assert.equal(status.result, "rejected");
  assert.equal(status.publicationId, publicationId);
  assert.doesNotMatch(status.reason, new RegExp(target.replaceAll("/", "\\/")));
});

test("运行中的宿主监听新完成的当天 Candidate 并自动发布", async () => {
  const { target, publication } = await fixture();
  let resolvePublished;
  const published = new Promise((resolve) => { resolvePublished = resolve; });
  const host = await startCandidateHost(target, {
    today: "2026-08-20",
    debounceMs: 20,
    pollMs: 25,
    rebuild: async () => {},
    onStatus: (status) => {
      if (status.result === "published") resolvePublished(status);
    },
  });
  try {
    const candidate = candidateFromIssue(createTestIssue("2026-08-20"));
    await writeCandidate(publication, candidate);
    let timeout;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("监听发布超时")), 2000);
    });
    const status = await Promise.race([published, timedOut]).finally(() => clearTimeout(timeout));
    assert.equal(status.writerResult, "created");
    assert.equal(status.revision, 1);
  } finally {
    host.close();
  }
});
