import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyV010Migration,
  createV010MigrationPlan,
} from "../scripts/lib/migration-v0.10.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-v010-migration-"));
  await cp(path.join(rootDir, "themes"), path.join(target, "themes"), { recursive: true });
  await mkdir(path.join(target, "config"), { recursive: true });
  await writeJson(path.join(target, "config", "publications.json"), {
    schemaVersion: 1,
    defaultPublicationId: "ai-daily",
    publicationIds: ["ai-daily", "finance-daily"],
  });
  for (const id of ["ai-daily", "finance-daily"]) {
    const publication = path.join(target, "publications", id);
    await mkdir(path.join(publication, "config"), { recursive: true });
    await mkdir(path.join(publication, "themes"), { recursive: true });
    await writeJson(path.join(publication, "config", "theme.json"), {
      schemaVersion: 1,
      activeTheme: { id: "newspaper-default", revision: 1 },
    });
    await cp(path.join(rootDir, "themes", "active.json"), path.join(publication, "themes", "active.json"));
  }
  return target;
}

test("v0.10 迁移先生成无写入报告，再经确认应用继承与覆盖", async () => {
  const target = await fixture();
  const plan = await createV010MigrationPlan(target, { enabled: false });
  await assert.rejects(() => readFile(path.join(target, "config", "home.json")), /ENOENT/);
  assert.equal(plan.home.enabled, false);
  assert.deepEqual(plan.home.activeTheme, { id: "newspaper-default", revision: 1 });
  assert.deepEqual(plan.publicationThemes, [
    {
      publicationId: "ai-daily",
      selection: { schemaVersion: 2, mode: "inherit" },
    },
    {
      publicationId: "finance-daily",
      selection: {
        schemaVersion: 2,
        mode: "override",
        activeTheme: { id: "newspaper-default", revision: 1 },
      },
    },
  ]);

  await assert.rejects(() => applyV010Migration(target, plan), /明确确认应用/);
  await applyV010Migration(target, plan, { confirm: "migrate-v0.11.0" });
  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, "config", "home.json"), "utf8")),
    plan.home,
  );
  assert.deepEqual(
    JSON.parse(await readFile(
      path.join(target, "publications", "ai-daily", "config", "theme.json"),
      "utf8",
    )),
    { schemaVersion: 2, mode: "inherit" },
  );
});

test("v0.10 迁移要求显式 Home 开关并拒绝覆盖既有 Home", async () => {
  const target = await fixture();
  await assert.rejects(() => createV010MigrationPlan(target), /enabled.*明确/);
  await writeJson(path.join(target, "config", "home.json"), { existing: true });
  await assert.rejects(
    () => createV010MigrationPlan(target, { enabled: true }),
    /已存在.*拒绝猜测合并/,
  );
});
