import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, beforeEach } from "node:test";
import pg from "pg";
import { runMigrations } from "../../.cloud-dist/src/adapters/postgres/migrations.js";
import {
  PostgresTenancyStore,
  TenancyError,
} from "../../.cloud-dist/src/adapters/postgres/tenancy.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
}
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
const pool = new Pool({ connectionString, max: 20, connectionTimeoutMillis: 5000 });
const store = new PostgresTenancyStore(pool);

async function resetAndMigrate() {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await runMigrations(pool, { migrationsDirectory: new URL("../../db/migrations", import.meta.url).pathname });
}

async function tableCount(table) {
  const result = await pool.query(`SELECT count(*)::integer AS count FROM app.${table}`);
  return result.rows[0].count;
}

async function addPublication(spaceId, publicationId, displayName, timeZone = "UTC") {
  await pool.query(
    `INSERT INTO app.publications (space_id, publication_id, display_name, sort_order)
     VALUES ($1, $2, $3, (
       SELECT COALESCE(max(sort_order), -1) + 1 FROM app.publications WHERE space_id = $1
     ))`,
    [spaceId, publicationId, displayName],
  );
  await pool.query(
    `INSERT INTO app.publication_configs (space_id, publication_id, time_zone, priority_limits)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [spaceId, publicationId, timeZone, JSON.stringify(defaults.priorityLimits)],
  );
}

beforeEach(resetAndMigrate);

after(async () => {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await pool.end();
});

test("tenant, identity, and Agent access migrations create the bounded app tables", async () => {
  const result = await pool.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'app'
    ORDER BY tablename
  `);
  const tables = result.rows.map(({ tablename }) => tablename);
  for (const table of [
    "agent_credentials",
    "agent_rate_limit_events",
    "audit_events",
    "custom_themes",
    "home_profiles",
    "login_mail_deliveries",
    "login_rate_locks",
    "login_send_attempts",
    "publication_configs",
    "publications",
    "schema_migrations",
    "spaces",
    "theme_selections",
    "todo_profiles",
    "user_profiles",
  ]) {
    assert.ok(tables.includes(table), `${table} must remain available`);
  }
  assert.equal(tables.some((table) => table.includes("pairing")), false);
  assert.ok(!tables.some((table) => table.startsWith("auth_")));
});

test("concurrent bootstrap creates one ready space and one complete default object set", async () => {
  const contexts = await Promise.all(
    Array.from({ length: 12 }, () => store.ensureSpaceForUser("auth-user-concurrent", defaults)),
  );
  assert.equal(new Set(contexts.map(({ spaceId }) => spaceId)).size, 1);

  assert.equal(await tableCount("spaces"), 1);
  assert.equal(await tableCount("home_profiles"), 1);
  assert.equal(await tableCount("publications"), 1);
  assert.equal(await tableCount("publication_configs"), 1);
  assert.equal(await tableCount("theme_selections"), 2);
  assert.equal(await tableCount("todo_profiles"), 1);

  const tenant = await store.resolveTenantContextForUser("auth-user-concurrent");
  assert.ok(tenant);
  const repository = store.forTenant(tenant);
  assert.deepEqual(await repository.getHomeProfile(), {
    spaceId: tenant.spaceId,
    displayName: "我的日报",
    timeZone: "Asia/Shanghai",
  });
  assert.deepEqual(await repository.getTodoProfile(), {
    spaceId: tenant.spaceId,
    enabled: false,
  });
  assert.deepEqual(await repository.listPublications(), [{
    spaceId: tenant.spaceId,
    publicationId: "daily-news",
    displayName: "DailyNews",
    status: "active",
    isDefault: true,
    sortOrder: 0,
  }]);
  assert.deepEqual(await repository.listThemeSelections(), [
    {
      targetType: "home",
      publicationId: null,
      selectionMode: "override",
      themeId: "newspaper-default",
    },
    {
      targetType: "publication",
      publicationId: "daily-news",
      selectionMode: "inherit",
      themeId: null,
    },
  ]);
});

test("bootstrap failure rolls back all business objects and a later retry recovers", async () => {
  await pool.query(`
    CREATE FUNCTION app.reject_publication_config() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected bootstrap failure';
    END
    $$;
    CREATE TRIGGER reject_publication_config
      BEFORE INSERT ON app.publication_configs
      FOR EACH ROW EXECUTE FUNCTION app.reject_publication_config();
  `);

  await assert.rejects(
    () => store.ensureSpaceForUser("auth-user-recovery", defaults),
    (error) => error instanceof TenancyError && error.code === "SPACE_BOOTSTRAP_FAILED",
  );
  for (const table of [
    "spaces",
    "home_profiles",
    "publications",
    "publication_configs",
    "theme_selections",
    "todo_profiles",
  ]) {
    assert.equal(await tableCount(table), 0, `${table} must be empty after rollback`);
  }

  await pool.query("DROP TRIGGER reject_publication_config ON app.publication_configs");
  await pool.query("DROP FUNCTION app.reject_publication_config()");
  const context = await store.ensureSpaceForUser("auth-user-recovery", defaults);
  assert.ok(context.spaceId);
  assert.equal((await store.forTenant(context).getSpace()).status, "ready");
});

test("bootstrap compensates a committed initializing space without changing its identity", async () => {
  const spaceId = randomUUID();
  await pool.query(
    "INSERT INTO app.spaces (id, user_id, status) VALUES ($1, $2, 'initializing')",
    [spaceId, "auth-user-partial"],
  );
  assert.equal(await store.resolveTenantContextForUser("auth-user-partial"), null);

  const context = await store.ensureSpaceForUser("auth-user-partial", defaults);
  assert.equal(context.spaceId, spaceId);
  assert.equal(await tableCount("spaces"), 1);
  assert.equal(await tableCount("home_profiles"), 1);
  assert.equal(await tableCount("publications"), 1);
  assert.equal(await tableCount("publication_configs"), 1);
  assert.equal(await tableCount("theme_selections"), 2);
  assert.equal(await tableCount("todo_profiles"), 1);
});

test("repeated bootstrap preserves existing user-facing defaults", async () => {
  const context = await store.ensureSpaceForUser("auth-user-existing", defaults);
  await pool.query(
    "UPDATE app.home_profiles SET display_name = '自定义主页' WHERE space_id = $1",
    [context.spaceId],
  );
  await pool.query("UPDATE app.todo_profiles SET enabled = true WHERE space_id = $1", [context.spaceId]);

  const repeated = await store.ensureSpaceForUser("auth-user-existing", {
    ...defaults,
    spaceName: "新的部署默认值",
    publicationId: "new-deployment-default",
    publicationName: "New Deployment Default",
    todoEnabled: false,
  });
  assert.equal(repeated.spaceId, context.spaceId);
  assert.equal((await store.forTenant(repeated).getHomeProfile()).displayName, "自定义主页");
  assert.equal((await store.forTenant(repeated).getTodoProfile()).enabled, true);
  assert.deepEqual(
    (await store.forTenant(repeated).listPublications()).map(({ publicationId }) => publicationId),
    ["daily-news"],
  );
  assert.equal(await tableCount("spaces"), 1);
  assert.equal(await tableCount("theme_selections"), 2);
});

test("composite foreign keys reject cross-space publication ownership", async () => {
  const tenantA = await store.ensureSpaceForUser("auth-user-owner-a", defaults);
  const tenantB = await store.ensureSpaceForUser("auth-user-owner-b", defaults);
  await addPublication(tenantB.spaceId, "owned-by-b", "Owned by B");

  await assert.rejects(
    () => pool.query(
      `INSERT INTO app.publication_configs (space_id, publication_id, time_zone, priority_limits)
       VALUES ($1, 'owned-by-b', 'UTC', $2::jsonb)`,
      [tenantA.spaceId, JSON.stringify(defaults.priorityLimits)],
    ),
    (error) => error.code === "23503",
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO app.theme_selections
         (id, space_id, target_type, publication_id, selection_mode, theme_id)
       VALUES ($1, $2, 'publication', 'owned-by-b', 'inherit', NULL)`,
      [randomUUID(), tenantA.spaceId],
    ),
    (error) => error.code === "23503",
  );
});

test("resolved repositories cannot cross Space, Publication, or Todo boundaries", async () => {
  const tenantA = await store.ensureSpaceForUser("auth-user-a", defaults);
  const tenantB = await store.ensureSpaceForUser("auth-user-b", defaults);
  assert.notEqual(tenantA.spaceId, tenantB.spaceId);

  await addPublication(tenantA.spaceId, "private-a", "Private A", "Etc/UTC");
  await addPublication(tenantB.spaceId, "private-b", "Private B", "Europe/Paris");
  await pool.query("UPDATE app.todo_profiles SET enabled = true WHERE space_id = $1", [tenantB.spaceId]);

  const tenantRepositoryA = store.forTenant(tenantA);
  assert.deepEqual(
    (await tenantRepositoryA.listPublications()).map(({ publicationId }) => publicationId),
    ["daily-news", "private-a"],
  );
  assert.equal((await tenantRepositoryA.getTodoProfile()).enabled, false);
  assert.equal(await store.resolvePublicationContext(tenantA, "private-b"), null);

  const publicationA = await store.resolvePublicationContext(tenantA, "daily-news");
  assert.ok(publicationA);
  const publicationRepositoryA = store.forPublication(publicationA);
  assert.equal((await publicationRepositoryA.getPublication()).publicationId, "daily-news");
  assert.equal((await publicationRepositoryA.getConfig()).timeZone, "Asia/Shanghai");
  assert.equal((await publicationRepositoryA.getThemeSelection()).selectionMode, "inherit");

  assert.throws(
    () => store.forTenant({ userId: tenantB.userId, spaceId: tenantB.spaceId }),
    (error) => error instanceof TenancyError && error.code === "TENANCY_INPUT_INVALID",
  );
});
