import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { createDailyApplicationService } from "../../scripts/lib/application/daily-service.js";
import { createTodoApplicationService } from "../../scripts/lib/application/todo-service.js";
import { validateCandidateValue } from "../../scripts/lib/domain/content-validation.js";
import { validateTodoCandidate, validateTodoState } from "../../scripts/lib/domain/todo-validation.js";
import { createFileDailyStorage } from "../../scripts/lib/storage/file-daily.js";
import { createFileThemeStorage } from "../../scripts/lib/storage/file-theme.js";
import { createFileTodoStorage } from "../../scripts/lib/storage/file-todo.js";
import { createTestIssue } from "../../test-support/helpers.js";
import { createPostgresDailyStorage, DailyStorageError } from "../../.cloud-dist/src/adapters/postgres/daily.js";
import { runMigrations } from "../../.cloud-dist/src/adapters/postgres/migrations.js";
import { createPostgresThemeStorage } from "../../.cloud-dist/src/adapters/postgres/theme.js";
import { PostgresTenancyStore } from "../../.cloud-dist/src/adapters/postgres/tenancy.js";
import { createPostgresTodoStorage, TodoStorageError } from "../../.cloud-dist/src/adapters/postgres/todo.js";
import { createCloudDailyCoordinator } from "../../.cloud-dist/src/modules/daily/cloud-coordinator.js";
import { createCloudTodoCoordinator } from "../../.cloud-dist/src/modules/todo/cloud-coordinator.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDirectory = path.join(projectRoot, "db", "migrations");
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
if (!/(?:test|ci)/i.test(databaseName)) {
  throw new Error("PostgreSQL integration tests require a dedicated test or CI database");
}

const defaults = {
  spaceName: "我的日报",
  timeZone: "Asia/Shanghai",
  publicationId: "daily-news",
  publicationName: "DailyNews",
  theme: { id: "newspaper-default", revision: 1 },
  todoEnabled: false,
  priorityLimits: { lead: 1, important: 2, normal: null },
};

const { Pool } = pg;
const pool = new Pool({ connectionString, max: 30, connectionTimeoutMillis: 5000 });
const tenancy = new PostgresTenancyStore(pool);
const temporaryDirectories = new Set();

function candidateFromIssue(issue) {
  const candidate = JSON.parse(JSON.stringify(issue));
  delete candidate.revision;
  return candidate;
}

function singleCandidate(date, suffix) {
  const issue = createTestIssue(date, ["normal"]);
  issue.items[0].id = `item-${suffix}`;
  issue.items[0].title = `标题 ${suffix}`;
  issue.items[0].brief = `短摘要 ${suffix}`;
  issue.items[0].summary = `完整摘要 ${suffix}`;
  issue.items[0].sources = [{ name: `来源 ${suffix}`, url: `https://example.com/${date}/${suffix}` }];
  return candidateFromIssue(issue);
}

async function resetAndMigrate() {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await runMigrations(pool, { migrationsDirectory });
}

async function createContext(userId, { todoEnabled = false } = {}) {
  const tenant = await tenancy.ensureSpaceForUser(userId, defaults);
  if (todoEnabled) {
    await pool.query("UPDATE app.todo_profiles SET enabled = true WHERE space_id = $1", [tenant.spaceId]);
  }
  const publication = await tenancy.resolvePublicationContext(tenant, defaults.publicationId);
  assert.ok(publication);
  return { tenant, publication };
}

function dailyCoordinator(publication) {
  const storage = createPostgresDailyStorage(pool, publication);
  return {
    storage,
    coordinator: createCloudDailyCoordinator({
      storage,
      publicationId: publication.publicationId,
      validateCandidate: (candidate) => validateCandidateValue(candidate, {
        filePath: "cloud-candidate",
        expectedDate: candidate?.date,
        validateAsset: async () => {},
      }),
      createApplicationService: createDailyApplicationService,
    }),
  };
}

function todoCoordinator(tenant, generateId = () => "todo-1234abcd") {
  const storage = createPostgresTodoStorage(pool, tenant);
  return {
    storage,
    coordinator: createCloudTodoCoordinator({
      storage,
      createApplicationService: (applicationStorage) => createTodoApplicationService(applicationStorage, {
        validateCandidate: validateTodoCandidate,
        validateState: validateTodoState,
        generateId,
        normalizeNow: (value) => {
          const normalized = value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
          if (typeof normalized !== "string" || Number.isNaN(Date.parse(normalized))) {
            throw new Error("now must be a valid timestamp");
          }
          return normalized;
        },
      }),
    }),
  };
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function insertCustomTheme(spaceId, themeId, revisions, currentRevision = Math.max(...revisions)) {
  for (const revision of revisions) {
    await pool.query(
      `INSERT INTO app.theme_definitions
         (space_id, theme_id, revision, definition_payload, compiled_css)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        spaceId,
        themeId,
        revision,
        JSON.stringify({
          schemaVersion: 1,
          id: themeId,
          name: `Custom ${themeId}`,
          revision,
          tokens: {},
          recipes: {},
        }),
        `:root { --custom-revision: ${revision}; }`,
      ],
    );
  }
  await pool.query(
    `INSERT INTO app.custom_themes
       (space_id, theme_id, display_name, current_revision)
     VALUES ($1, $2, $3, $4)`,
    [spaceId, themeId, `Custom ${themeId}`, currentRevision],
  );
}

beforeEach(resetAndMigrate);

after(async () => {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await pool.end();
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

test("Daily PostgreSQL Adapter matches the file Adapter for the same M1 input", async () => {
  const { publication } = await createContext("daily-equivalence-user");
  const { storage, coordinator } = dailyCoordinator(publication);
  const candidate = candidateFromIssue(createTestIssue("2026-08-25"));

  const fileRoot = await temporaryDirectory("dailynews-daily-equivalence-");
  const dataDir = path.join(fileRoot, "data");
  await Promise.all([
    mkdir(path.join(dataDir, "issues"), { recursive: true }),
    mkdir(path.join(dataDir, "compiled"), { recursive: true }),
  ]);
  const fileResult = await createDailyApplicationService(createFileDailyStorage({ dataDir })).submit({
    candidate,
    publicationId: "daily-news",
    priorityLimits: defaults.priorityLimits,
  });
  const postgresResult = await coordinator.submit({
    clientRunId: "daily-equivalence-01",
    candidate,
  });

  assert.deepEqual(postgresResult, fileResult);
  assert.deepEqual(await storage.readIssue(candidate.date), await readJson(path.join(dataDir, "issues", `${candidate.date}.json`)));
  assert.deepEqual(await storage.readCompiled(candidate.date), await readJson(path.join(dataDir, "compiled", `${candidate.date}.json`)));
  assert.deepEqual(await storage.readIndex(), await readJson(path.join(dataDir, "index.json")));
  const snapshot = await storage.readSnapshot();
  assert.equal(snapshot.date, candidate.date);
  assert.deepEqual(snapshot.issue, await storage.readIssue(candidate.date));
  assert.deepEqual(snapshot.compiled, await storage.readCompiled(candidate.date));
});

test("Daily idempotency is canonical, conflict-safe, and race-safe", async () => {
  const { publication } = await createContext("daily-idempotency-user");
  const { storage, coordinator } = dailyCoordinator(publication);
  const candidate = singleCandidate("2026-08-25", "first");
  const reordered = Object.fromEntries(Object.entries(candidate).reverse());

  const [first, duplicate] = await Promise.all([
    coordinator.submit({ clientRunId: "daily-idempotent-01", candidate }),
    coordinator.submit({ clientRunId: "daily-idempotent-01", candidate: reordered }),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal((await storage.readIssue(candidate.date)).revision, 1);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.daily_candidates")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.daily_submission_runs")).rows[0].count, 1);

  const changed = structuredClone(candidate);
  changed.items[0].title = "不同输入";
  await assert.rejects(
    () => coordinator.submit({ clientRunId: "daily-idempotent-01", candidate: changed }),
    (error) => error instanceof DailyStorageError && error.code === "DAILY_IDEMPOTENCY_CONFLICT",
  );
});

test("Daily date locking serializes different runs without losing revisions", async () => {
  const { publication } = await createContext("daily-concurrency-user");
  const { storage, coordinator } = dailyCoordinator(publication);
  const first = singleCandidate("2026-08-25", "alpha");
  const second = singleCandidate("2026-08-25", "beta");
  const results = await Promise.all([
    coordinator.submit({ clientRunId: "daily-concurrent-a", candidate: first }),
    coordinator.submit({ clientRunId: "daily-concurrent-b", candidate: second }),
  ]);
  assert.deepEqual(results.map(({ revision }) => revision).sort(), [1, 2]);
  const issue = await storage.readIssue("2026-08-25");
  assert.equal(issue.revision, 2);
  assert.deepEqual(new Set(issue.items.map(({ id }) => id)), new Set(["item-alpha", "item-beta"]));
});

test("Daily compile and final persistence failures leave no formal state and retry cleanly", async () => {
  const { publication } = await createContext("daily-rollback-user");
  const { storage, coordinator } = dailyCoordinator(publication);
  const candidate = singleCandidate("2026-08-25", "rollback");
  await pool.query(
    `UPDATE app.publication_configs
     SET priority_limits = '{"lead":1,"important":2,"normal":0}'::jsonb
     WHERE space_id = $1 AND publication_id = $2`,
    [publication.tenant.spaceId, publication.publicationId],
  );
  await assert.rejects(() => coordinator.submit({ clientRunId: "daily-rollback-01", candidate }));
  assert.equal(await storage.readIssue(candidate.date), null);
  assert.equal(await storage.readCompiled(candidate.date), null);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.daily_candidates")).rows[0].count, 0);

  await pool.query(
    `UPDATE app.publication_configs
     SET priority_limits = $3::jsonb
     WHERE space_id = $1 AND publication_id = $2`,
    [publication.tenant.spaceId, publication.publicationId, JSON.stringify(defaults.priorityLimits)],
  );
  await pool.query(`
    CREATE FUNCTION app.reject_daily_run() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected daily persistence failure'; END
    $$;
    CREATE TRIGGER reject_daily_run BEFORE INSERT ON app.daily_submission_runs
      FOR EACH ROW EXECUTE FUNCTION app.reject_daily_run();
  `);
  await assert.rejects(() => coordinator.submit({ clientRunId: "daily-rollback-01", candidate }));
  assert.equal(await storage.readIssue(candidate.date), null);
  assert.equal(await storage.readCompiled(candidate.date), null);
  await pool.query("DROP TRIGGER reject_daily_run ON app.daily_submission_runs");
  await pool.query("DROP FUNCTION app.reject_daily_run()");
  assert.equal((await coordinator.submit({ clientRunId: "daily-rollback-01", candidate })).revision, 1);
});

test("Todo PostgreSQL Adapter matches the file Adapter and preserves idempotency", async () => {
  const { tenant } = await createContext("todo-equivalence-user", { todoEnabled: true });
  const candidate = {
    schemaVersion: 1,
    candidateId: "todo-equivalence-01",
    generatedAt: "2026-08-25T08:00:00+08:00",
    baseRevision: 0,
    operations: [{ type: "add", clientId: "first", title: "数据库等价测试" }],
  };
  const now = "2026-08-25T08:01:00+08:00";
  const fileRoot = await temporaryDirectory("dailynews-todo-equivalence-");
  const dataDir = path.join(fileRoot, "data");
  const statePath = path.join(dataDir, "state.json");
  await Promise.all([
    mkdir(path.join(dataDir, "submissions"), { recursive: true }),
    mkdir(path.join(dataDir, ".locks"), { recursive: true }),
  ]);
  await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: null, items: [] }, null, 2)}\n`);
  const fileStorage = createFileTodoStorage({ dataDir, statePath, readState: () => readJson(statePath) });
  const dependencies = {
    validateCandidate: validateTodoCandidate,
    validateState: validateTodoState,
    generateId: () => "todo-1234abcd",
    normalizeNow: (value) => value,
  };
  const fileResult = await createTodoApplicationService(fileStorage, dependencies).submit({
    candidateId: candidate.candidateId,
    candidate,
    now,
  });
  const { storage, coordinator } = todoCoordinator(tenant);
  const postgresResult = await coordinator.submit({ clientRunId: "todo-equivalence-run", candidate, now });
  assert.deepEqual(postgresResult, fileResult);
  assert.deepEqual(await storage.readState(), await readJson(statePath));
  assert.deepEqual(await coordinator.submit({
    clientRunId: "todo-equivalence-run",
    candidate: Object.fromEntries(Object.entries(candidate).reverse()),
  }), postgresResult);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.todo_submission_runs")).rows[0].count, 1);

  const changed = structuredClone(candidate);
  changed.operations[0].title = "不同输入";
  await assert.rejects(
    () => coordinator.submit({ clientRunId: "todo-equivalence-run", candidate: changed, now }),
    (error) => error instanceof TodoStorageError && error.code === "TODO_IDEMPOTENCY_CONFLICT",
  );
});

test("Todo profile locking prevents lost revisions and records rejected concurrent work", async () => {
  const { tenant } = await createContext("todo-concurrency-user", { todoEnabled: true });
  let id = 0;
  const { storage, coordinator } = todoCoordinator(tenant, () => `todo-${(++id).toString(16).padStart(8, "0")}`);
  const candidate = (candidateId, title) => ({
    schemaVersion: 1,
    candidateId,
    generatedAt: "2026-08-25T08:00:00+08:00",
    baseRevision: 0,
    operations: [{ type: "add", clientId: candidateId, title }],
  });
  const results = await Promise.all([
    coordinator.submit({ clientRunId: "todo-concurrent-run-a", candidate: candidate("todo-concurrent-a", "A"), now: "2026-08-25T08:01:00+08:00" }),
    coordinator.submit({ clientRunId: "todo-concurrent-run-b", candidate: candidate("todo-concurrent-b", "B"), now: "2026-08-25T08:01:01+08:00" }),
  ]);
  assert.deepEqual(new Set(results.map(({ result }) => result)), new Set(["published", "rejected"]));
  assert.equal((await storage.readState()).revision, 1);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.todo_submission_runs")).rows[0].count, 2);
});

test("Todo disabled and persistence failure both fail closed with recoverable state", async () => {
  const { tenant } = await createContext("todo-rollback-user");
  const { storage, coordinator } = todoCoordinator(tenant);
  const candidate = {
    schemaVersion: 1,
    candidateId: "todo-rollback-01",
    generatedAt: "2026-08-25T08:00:00+08:00",
    baseRevision: 0,
    operations: [{ type: "add", clientId: "first", title: "回滚测试" }],
  };
  await assert.rejects(
    () => coordinator.submit({ clientRunId: "todo-rollback-run", candidate, now: "2026-08-25T08:01:00+08:00" }),
    (error) => error instanceof TodoStorageError && error.code === "TODO_DISABLED",
  );
  await pool.query("UPDATE app.todo_profiles SET enabled = true WHERE space_id = $1", [tenant.spaceId]);
  await pool.query(`
    CREATE FUNCTION app.reject_todo_run() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected Todo persistence failure'; END
    $$;
    CREATE TRIGGER reject_todo_run BEFORE INSERT ON app.todo_submission_runs
      FOR EACH ROW EXECUTE FUNCTION app.reject_todo_run();
  `);
  await assert.rejects(() => coordinator.submit({ clientRunId: "todo-rollback-run", candidate, now: "2026-08-25T08:01:00+08:00" }));
  assert.equal((await storage.readState()).revision, 0);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.todo_states")).rows[0].count, 0);
  await pool.query("DROP TRIGGER reject_todo_run ON app.todo_submission_runs");
  await pool.query("DROP FUNCTION app.reject_todo_run()");
  assert.equal((await coordinator.submit({ clientRunId: "todo-rollback-run", candidate, now: "2026-08-25T08:01:00+08:00" })).result, "published");
});

test("Theme PostgreSQL Adapter resolves ID-only selections through the current revision", async () => {
  const { tenant, publication } = await createContext("theme-equivalence-user");
  const systemThemes = createFileThemeStorage({ rootDir: projectRoot });
  const storage = createPostgresThemeStorage(pool, tenant, systemThemes, publication);

  assert.deepEqual(await storage.readSelection(), { schemaVersion: 3, mode: "inherit" });
  const inherited = await storage.resolveEffectiveTheme();
  assert.equal(inherited.themeId, "newspaper-default");
  assert.equal(inherited.source, "official");
  assert.equal(inherited.selectionMode, "inherit");

  await insertCustomTheme(tenant.spaceId, "postgres-theme", [1, 2], 2);
  await pool.query(
    `UPDATE app.theme_selections
     SET selection_mode = 'override', theme_id = 'postgres-theme'
     WHERE space_id = $1 AND publication_id = $2`,
    [tenant.spaceId, publication.publicationId],
  );
  assert.deepEqual(await storage.readSelection(), {
    schemaVersion: 3,
    mode: "override",
    themeId: "postgres-theme",
  });
  assert.equal((await storage.resolveEffectiveTheme()).revision, 2);

  await pool.query(
    `UPDATE app.custom_themes SET current_revision = 1
     WHERE space_id = $1 AND theme_id = 'postgres-theme'`,
    [tenant.spaceId],
  );
  const effective = await storage.resolveEffectiveTheme();
  assert.equal(effective.revision, 1);
  assert.equal(effective.source, "custom");
  assert.match(effective.css, /custom-revision: 1/);
});

test("Daily, Todo, and Theme records remain isolated by resolved tenant context", async () => {
  const first = await createContext("isolation-user-a", { todoEnabled: true });
  const second = await createContext("isolation-user-b", { todoEnabled: true });
  const dailyA = dailyCoordinator(first.publication);
  const dailyB = dailyCoordinator(second.publication);
  const dailyCandidate = singleCandidate("2026-08-25", "isolated");
  await dailyA.coordinator.submit({ clientRunId: "daily-isolation-a", candidate: dailyCandidate });
  assert.equal(await dailyB.storage.readIssue(dailyCandidate.date), null);

  const todoA = todoCoordinator(first.tenant);
  const todoB = todoCoordinator(second.tenant);
  await todoA.coordinator.submit({
    clientRunId: "todo-isolation-run-a",
    candidate: {
      schemaVersion: 1,
      candidateId: "todo-isolation-a",
      generatedAt: "2026-08-25T08:00:00+08:00",
      baseRevision: 0,
      operations: [{ type: "add", clientId: "first", title: "仅 A 可见" }],
    },
    now: "2026-08-25T08:01:00+08:00",
  });
  assert.equal((await todoB.storage.readState()).revision, 0);

  const systemThemes = createFileThemeStorage({ rootDir: projectRoot });
  const themeA = createPostgresThemeStorage(pool, first.tenant, systemThemes, first.publication);
  const themeB = createPostgresThemeStorage(pool, second.tenant, systemThemes, second.publication);
  await insertCustomTheme(first.tenant.spaceId, "isolated-theme", [1]);
  assert.equal((await themeA.readCurrentTheme("isolated-theme")).themeId, "isolated-theme");
  assert.equal(await themeB.readCurrentTheme("isolated-theme"), null);
});

test("Theme storage retains historical custom revisions while hiding deleted current themes", async () => {
  const { tenant, publication } = await createContext("theme-system-user");
  const systemThemes = createFileThemeStorage({ rootDir: projectRoot });
  const storage = createPostgresThemeStorage(pool, tenant, systemThemes, publication);
  await insertCustomTheme(tenant.spaceId, "history-theme", [1, 2], 2);

  assert.equal((await storage.readCurrentTheme("history-theme")).revision, 2);
  assert.equal((await storage.readThemeRevision("history-theme", 1)).definition.revision, 1);
  await pool.query(
    `UPDATE app.custom_themes
     SET status = 'deleted', deleted_at = clock_timestamp()
     WHERE space_id = $1 AND theme_id = 'history-theme'`,
    [tenant.spaceId],
  );
  assert.equal(await storage.readCurrentTheme("history-theme"), null);
  assert.equal((await storage.readThemeRevision("history-theme", 1)).definition.revision, 1);
  assert.ok(!(await storage.listThemes()).some(({ themeId }) => themeId === "history-theme"));
});
