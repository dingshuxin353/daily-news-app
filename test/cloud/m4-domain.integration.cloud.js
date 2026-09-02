import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { createFileThemeStorage } from "../../scripts/lib/storage/file-theme.js";
import { compileIssue } from "../../scripts/lib/compiler.js";
import { runMigrations } from "../../.cloud-dist/src/adapters/postgres/migrations.js";
import { PostgresSiteManagementRepository } from "../../.cloud-dist/src/adapters/postgres/site-management.js";
import { createPostgresThemeStorage } from "../../.cloud-dist/src/adapters/postgres/theme.js";
import { PostgresTenancyStore } from "../../.cloud-dist/src/adapters/postgres/tenancy.js";
import { ProfileError, UserProfileService } from "../../.cloud-dist/src/modules/identity/profile-service.js";
import { SiteManagementError, SiteManagementService } from "../../.cloud-dist/src/modules/site-management/service.js";
import { SiteThemeCatalogService } from "../../.cloud-dist/src/modules/site-management/theme-catalog.js";
import { PrivateReadingService } from "../../.cloud-dist/src/modules/private-reading/service.js";

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
const systemThemes = createFileThemeStorage({ rootDir: projectRoot });
const repository = new PostgresSiteManagementRepository(pool, systemThemes);
const sites = new SiteManagementService(repository, defaults, 8);
const profiles = new UserProfileService(pool);

async function resetAndMigrate() {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await runMigrations(pool, { migrationsDirectory });
}

async function createTenant(userId) {
  return tenancy.ensureSpaceForUser(userId, defaults);
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
        JSON.stringify({ schemaVersion: 1, id: themeId, name: `Theme ${themeId}`, revision }),
        `:root { --revision: ${revision}; }`,
      ],
    );
  }
  await pool.query(
    `INSERT INTO app.custom_themes
       (space_id, theme_id, display_name, current_revision)
     VALUES ($1, $2, $3, $4)`,
    [spaceId, themeId, `Theme ${themeId}`, currentRevision],
  );
}

async function insertFormalDaily(spaceId, publicationId, date, title) {
  const issue = {
    schemaVersion: 2,
    date,
    generatedAt: `${date}T08:00:00+08:00`,
    coverage: { start: `${date}T00:00:00+08:00`, end: `${date}T08:00:00+08:00` },
    revision: 1,
    items: [{
      id: `${publicationId}-item`,
      title,
      brief: "测试摘要",
      summary: "用于验证正式日报切换器的数据来源。",
      category: "测试",
      editorial: { priority: "lead", selectionReason: "集成验收" },
      sources: [{ name: "测试来源", url: "https://example.test/source" }],
    }],
  };
  const compiled = compileIssue(issue).compiled;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO app.issues (space_id, publication_id, issue_date, revision, issue_payload)
       VALUES ($1, $2, $3::date, 1, $4::jsonb)`,
      [spaceId, publicationId, date, JSON.stringify(issue)],
    );
    await client.query(
      `INSERT INTO app.compiled_editions (space_id, publication_id, issue_date, revision, compiled_payload)
       VALUES ($1, $2, $3::date, 1, $4::jsonb)`,
      [spaceId, publicationId, date, JSON.stringify(compiled)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(resetAndMigrate);

after(async () => {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await pool.end();
});

test("Publication management derives one primary from active order and enforces the eight-site contract", async () => {
  const tenant = await createTenant("m4-sites-user");
  await sites.createPublication(tenant, {
    publicationId: "site-2",
    name: "Site 2",
    theme: { mode: "inherit" },
  });
  await assert.rejects(
    () => sites.createPublication(tenant, {
      publicationId: "site-2",
      name: "Another Site",
      theme: { mode: "inherit" },
    }),
    (error) => error instanceof SiteManagementError && error.code === "SITE_ID_CONFLICT",
  );
  await assert.rejects(
    () => sites.createPublication(tenant, {
      publicationId: "another-site",
      name: "site 2",
      theme: { mode: "inherit" },
    }),
    (error) => error instanceof SiteManagementError && error.code === "SITE_NAME_CONFLICT",
  );
  assert.throws(
    () => sites.createPublication(tenant, {
      publicationId: "Unsafe_Path",
      name: "Unsafe",
      theme: { mode: "inherit" },
    }),
    (error) => error instanceof SiteManagementError && error.code === "SITE_INPUT_INVALID",
  );
  for (let index = 3; index <= 8; index += 1) {
    await sites.createPublication(tenant, {
      publicationId: `site-${index}`,
      name: `Site ${index}`,
      theme: { mode: "inherit" },
    });
  }
  const full = await sites.read(tenant);
  assert.equal(full.publications.length, 8);
  assert.deepEqual(full.publications.filter(({ isPrimary }) => isPrimary).map(({ publicationId }) => publicationId), ["daily-news"]);
  await assert.rejects(
    () => sites.createPublication(tenant, {
      publicationId: "site-9",
      name: "Site 9",
      theme: { mode: "inherit" },
    }),
    (error) => error instanceof SiteManagementError && error.code === "SITE_LIMIT_REACHED",
  );
  await assert.rejects(
    () => sites.renamePublication(tenant, "site-2", "dailynews"),
    (error) => error instanceof SiteManagementError && error.code === "SITE_NAME_CONFLICT",
  );

  const reversedIds = full.publications.map(({ publicationId }) => publicationId).reverse();
  const reordered = await sites.reorderPublications(tenant, reversedIds);
  assert.equal(reordered.publications.find(({ isPrimary }) => isPrimary).publicationId, "site-8");
  assert.equal(
    (await tenancy.forTenant(tenant).listPublications()).find(({ isDefault }) => isDefault).publicationId,
    "site-8",
  );
  const disabled = await sites.setPublicationStatus(tenant, "site-8", "inactive");
  assert.equal(disabled.publications.find(({ isPrimary }) => isPrimary).publicationId, "site-7");
  assert.equal(disabled.publications.find(({ publicationId }) => publicationId === "site-8").sortOrder, null);
  const restored = await sites.setPublicationStatus(tenant, "site-8", "active");
  assert.equal(restored.publications.at(-1).publicationId, "site-8");
  assert.equal(restored.publications.at(-1).sortOrder, 7);

  for (const publicationId of ["site-8", "site-6", "site-5", "site-4", "site-3", "site-2", "daily-news"]) {
    await sites.setPublicationStatus(tenant, publicationId, "inactive");
  }
  await assert.rejects(
    () => sites.setPublicationStatus(tenant, "site-7", "inactive"),
    (error) => error instanceof SiteManagementError && error.code === "SITE_LAST_ACTIVE",
  );
});

test("private shells derive the Daily switcher from active Publications with formal content in settings order", async () => {
  const tenant = await createTenant("m52-reading-switcher-user");
  await sites.createPublication(tenant, { publicationId: "empty-site", name: "Empty", theme: { mode: "inherit" } });
  await sites.createPublication(tenant, { publicationId: "second-site", name: "Second", theme: { mode: "inherit" } });
  await insertFormalDaily(tenant.spaceId, "daily-news", "2026-09-01", "Primary formal issue");
  await insertFormalDaily(tenant.spaceId, "second-site", "2026-09-02", "Second formal issue");

  const reading = new PrivateReadingService(pool, tenancy, systemThemes);
  const shell = await reading.readShell(tenant);
  assert.deepEqual(shell.readablePublications.map(({ publication }) => publication.publicationId), ["daily-news", "second-site"]);
  assert.deepEqual(shell.readablePublications.map(({ latest }) => latest?.date), ["2026-09-01", "2026-09-02"]);
  assert.deepEqual((await reading.readHome(tenant)).publications.map(({ publication }) => publication.publicationId), ["second-site"]);

  await sites.setPublicationStatus(tenant, "second-site", "inactive");
  assert.deepEqual((await reading.readShell(tenant)).readablePublications.map(({ publication }) => publication.publicationId), ["daily-news"]);
  const archivedShell = await reading.readPublicationShell(tenant, "second-site");
  assert.equal(archivedShell?.publication.status, "inactive");
  assert.deepEqual(archivedShell?.readablePublications.map(({ publication }) => publication.publicationId), ["daily-news"]);
});

test("Publication create serializes conflicts and rolls every dependent row back on failure", async () => {
  const tenant = await createTenant("m4-concurrency-user");
  const settled = await Promise.allSettled([
    sites.createPublication(tenant, {
      publicationId: "parallel-site",
      name: "Parallel One",
      theme: { mode: "inherit" },
    }),
    sites.createPublication(tenant, {
      publicationId: "parallel-site",
      name: "Parallel Two",
      theme: { mode: "inherit" },
    }),
  ]);
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await pool.query(
    "SELECT count(*)::integer AS count FROM app.publications WHERE space_id = $1 AND publication_id = 'parallel-site'",
    [tenant.spaceId],
  )).rows[0].count, 1);

  const nameSettled = await Promise.allSettled([
    sites.createPublication(tenant, {
      publicationId: "parallel-name-a",
      name: "Shared Name",
      theme: { mode: "inherit" },
    }),
    sites.createPublication(tenant, {
      publicationId: "parallel-name-b",
      name: "shared name",
      theme: { mode: "inherit" },
    }),
  ]);
  assert.equal(nameSettled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(nameSettled.filter(({ status }) => status === "rejected").length, 1);

  await pool.query(`
    CREATE FUNCTION app.reject_m4_selection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.publication_id = 'rollback-site' THEN
        RAISE EXCEPTION 'injected selection failure';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER reject_m4_selection BEFORE INSERT ON app.theme_selections
      FOR EACH ROW EXECUTE FUNCTION app.reject_m4_selection();
  `);
  await assert.rejects(
    () => sites.createPublication(tenant, {
      publicationId: "rollback-site",
      name: "Rollback Site",
      theme: { mode: "inherit" },
    }),
    (error) => error instanceof SiteManagementError && error.code === "SITE_STORAGE_FAILED",
  );
  const rollbackFacts = (await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM app.publications WHERE space_id = $1 AND publication_id = 'rollback-site') AS publication_count,
       (SELECT count(*)::integer FROM app.publication_configs WHERE space_id = $1 AND publication_id = 'rollback-site') AS config_count,
       (SELECT count(*)::integer FROM app.theme_selections WHERE space_id = $1 AND publication_id = 'rollback-site') AS selection_count`,
    [tenant.spaceId],
  )).rows[0];
  assert.deepEqual(rollbackFacts, { publication_count: 0, config_count: 0, selection_count: 0 });
});

test("browser-facing Publication save is atomic and locked moves never lose an active item", async () => {
  const tenant = await createTenant("m4-browser-save-user");
  await sites.createPublication(tenant, { publicationId: "alpha", name: "Alpha", theme: { mode: "inherit" } });
  await sites.createPublication(tenant, { publicationId: "beta", name: "Beta", theme: { mode: "inherit" } });

  const updated = await sites.updatePublication(tenant, "alpha", {
    name: "Alpha Updated",
    theme: { mode: "override", themeId: "swiss-editorial" },
  });
  assert.deepEqual(updated.publications.find(({ publicationId }) => publicationId === "alpha"), {
    publicationId: "alpha",
    name: "Alpha Updated",
    status: "active",
    sortOrder: 1,
    isPrimary: false,
    theme: { mode: "override", themeId: "swiss-editorial" },
  });

  await pool.query(`
    CREATE FUNCTION app.reject_m4_browser_theme_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.publication_id = 'alpha' AND NEW.theme_id = 'midnight-tech' THEN
        RAISE EXCEPTION 'injected browser theme failure';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER reject_m4_browser_theme_update BEFORE UPDATE ON app.theme_selections
      FOR EACH ROW EXECUTE FUNCTION app.reject_m4_browser_theme_update();
  `);
  await assert.rejects(
    () => sites.updatePublication(tenant, "alpha", {
      name: "Must Roll Back",
      theme: { mode: "override", themeId: "midnight-tech" },
    }),
    (error) => error instanceof SiteManagementError && error.code === "SITE_STORAGE_FAILED",
  );
  const afterFailure = (await sites.read(tenant)).publications.find(({ publicationId }) => publicationId === "alpha");
  assert.equal(afterFailure.name, "Alpha Updated");
  assert.deepEqual(afterFailure.theme, { mode: "override", themeId: "swiss-editorial" });

  const moves = await Promise.all([
    sites.movePublication(tenant, "beta", "up"),
    sites.movePublication(tenant, "daily-news", "down"),
  ]);
  for (const snapshot of moves) {
    assert.deepEqual(new Set(snapshot.publications.filter(({ status }) => status === "active").map(({ publicationId }) => publicationId)), new Set(["daily-news", "alpha", "beta"]));
  }
  const final = (await sites.read(tenant)).publications.filter(({ status }) => status === "active");
  assert.deepEqual(final.map(({ sortOrder }) => sortOrder), [0, 1, 2]);
  assert.equal(final.filter(({ isPrimary }) => isPrimary).length, 1);
});

test("Site management and custom theme reads remain scoped to the resolved Space", async () => {
  const first = await createTenant("m4-isolation-a");
  const second = await createTenant("m4-isolation-b");
  await sites.createPublication(first, {
    publicationId: "private-a",
    name: "Private A",
    theme: { mode: "inherit" },
  });
  await assert.rejects(
    () => sites.renamePublication(second, "private-a", "Intrusion"),
    (error) => error instanceof SiteManagementError && error.code === "SITE_TARGET_NOT_FOUND",
  );
  assert.equal((await sites.read(first)).publications.find(({ publicationId }) => publicationId === "private-a").name, "Private A");
  assert.ok(!(await sites.read(second)).publications.some(({ publicationId }) => publicationId === "private-a"));

  await insertCustomTheme(first.spaceId, "space-a-theme", [1]);
  const firstThemes = createPostgresThemeStorage(pool, first, systemThemes);
  const secondThemes = createPostgresThemeStorage(pool, second, systemThemes);
  assert.equal((await firstThemes.readCurrentTheme("space-a-theme")).source, "custom");
  assert.equal(await secondThemes.readCurrentTheme("space-a-theme"), null);
});

test("Theme selections follow current revisions while official IDs cannot be shadowed", async () => {
  const tenant = await createTenant("m4-theme-user");
  const publication = await tenancy.resolvePublicationContext(tenant, "daily-news");
  assert.ok(publication);
  await insertCustomTheme(tenant.spaceId, "shared-theme", [1, 2], 1);
  await sites.updateHome(tenant, { themeId: "shared-theme" });
  await sites.setPublicationTheme(tenant, "daily-news", { mode: "inherit" });
  const homeThemes = createPostgresThemeStorage(pool, tenant, systemThemes);
  const publicationThemes = createPostgresThemeStorage(pool, tenant, systemThemes, publication);
  assert.equal((await homeThemes.resolveEffectiveTheme()).revision, 1);
  assert.equal((await publicationThemes.resolveEffectiveTheme()).revision, 1);

  await pool.query(
    "UPDATE app.custom_themes SET current_revision = 2 WHERE space_id = $1 AND theme_id = 'shared-theme'",
    [tenant.spaceId],
  );
  assert.equal((await homeThemes.resolveEffectiveTheme()).revision, 2);
  assert.equal((await publicationThemes.resolveEffectiveTheme()).revision, 2);

  await insertCustomTheme(tenant.spaceId, "newspaper-default", [2]);
  const official = await homeThemes.readCurrentTheme("newspaper-default");
  assert.equal(official.source, "official");
  assert.ok(!(await homeThemes.listThemes()).some(({ themeId, source }) => themeId === "newspaper-default" && source === "custom"));
});

test("browser theme catalog returns fixed safe previews without compiled CSS", async () => {
  const tenant = await createTenant("m4-browser-theme-user");
  const catalog = await new SiteThemeCatalogService(pool, systemThemes).list(tenant);
  assert.deepEqual(catalog.map(({ themeId }) => themeId), ["midnight-tech", "newspaper-default", "swiss-editorial"]);
  for (const theme of catalog) {
    assert.equal(theme.source, "official");
    assert.match(theme.preview.background, /^#[0-9A-F]{6}$/i);
    assert.deepEqual(Object.keys(theme.preview).sort(), ["accent", "background", "muted", "rule", "text"]);
    assert.doesNotMatch(JSON.stringify(theme), /compiledCss|compiled_css|:root/);
  }
});

test("Todo formal-data projection and explicit nicknames preserve independent facts atomically", async () => {
  const tenant = await createTenant("m4-profile-space-user");
  assert.deepEqual((await sites.read(tenant)).todo, { enabled: false, hasFormalData: false });
  await pool.query(
    `INSERT INTO app.todo_states (space_id, revision, state_payload)
     VALUES ($1, 1, '{"schemaVersion":1,"revision":1,"updatedAt":null,"items":[]}'::jsonb)`,
    [tenant.spaceId],
  );
  assert.deepEqual((await sites.read(tenant)).todo, { enabled: false, hasFormalData: true });
  assert.deepEqual((await sites.setTodoEnabled(tenant, true)).todo, { enabled: true, hasFormalData: true });
  assert.deepEqual((await sites.setTodoEnabled(tenant, false)).todo, { enabled: false, hasFormalData: true });

  await pool.query(
    `INSERT INTO auth."user" ("id", "name", "email", "emailVerified")
     VALUES
       ('profile-email-name', 'email-name@example.test', 'email-name@example.test', true),
       ('profile-legacy-name', 'Existing Nickname', 'legacy@example.test', true),
       ('profile-rollback', 'rollback@example.test', 'rollback@example.test', true)`,
  );
  assert.deepEqual(await profiles.read("profile-email-name"), {
    userId: "profile-email-name",
    email: "email-name@example.test",
    nickname: null,
    complete: false,
  });
  assert.equal((await profiles.read("profile-legacy-name")).nickname, "Existing Nickname");
  const updated = await profiles.setNickname("profile-email-name", "  丁丁  ");
  assert.equal(updated.nickname, "丁丁");
  assert.equal((await pool.query("SELECT \"name\" FROM auth.\"user\" WHERE \"id\" = 'profile-email-name'")).rows[0].name, "丁丁");
  await assert.rejects(
    () => profiles.setNickname("profile-email-name", "line\nbreak"),
    (error) => error instanceof ProfileError && error.code === "PROFILE_INPUT_INVALID",
  );

  await pool.query(`
    CREATE FUNCTION app.reject_profile_identity_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."id" = 'profile-rollback' THEN
        RAISE EXCEPTION 'injected profile identity failure';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER reject_profile_identity_update BEFORE UPDATE ON auth."user"
      FOR EACH ROW EXECUTE FUNCTION app.reject_profile_identity_update();
  `);
  await assert.rejects(
    () => profiles.setNickname("profile-rollback", "Atomic Nickname"),
    (error) => error instanceof ProfileError && error.code === "PROFILE_STORAGE_FAILED",
  );
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.user_profiles WHERE user_id = 'profile-rollback'")).rows[0].count, 0);
  assert.equal((await profiles.read("profile-rollback")).nickname, null);
});
