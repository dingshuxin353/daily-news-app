import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

import { createTestIssue } from "../../test-support/helpers.js";
import { PostgresAgentAccessRepository } from "../../.cloud-dist/src/adapters/postgres/agent-credentials.js";
import { PostgresAgentRequestPolicy } from "../../.cloud-dist/src/adapters/postgres/agent-rate-limit.js";
import { discoverMigrations, runMigrations } from "../../.cloud-dist/src/adapters/postgres/migrations.js";
import { PostgresTenancyStore } from "../../.cloud-dist/src/adapters/postgres/tenancy.js";
import { createCloudApp } from "../../.cloud-dist/src/cloud/app.js";
import { AgentRequestAuthenticator } from "../../.cloud-dist/src/cloud/agent-context.js";
import { AgentCredentialService } from "../../.cloud-dist/src/modules/agent-access/credential-service.js";
import { AgentOperationsService } from "../../.cloud-dist/src/modules/agent-access/operations.js";
import { AgentRequestError } from "../../.cloud-dist/src/modules/agent-access/request-policy.js";
import { keyedDigest } from "../../.cloud-dist/src/modules/identity/security.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDirectory = path.join(projectRoot, "db", "migrations");
const openApi = JSON.parse(await readFile(path.join(projectRoot, "docs", "openapi-v1.yaml"), "utf8"));
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
const digestSecret = "agent-api-integration-digest-secret-at-least-32-characters";
const pairingSecret = "agent-api-integration-pairing-secret-at-least-32-characters";
const { Pool } = pg;
const pool = new Pool({ connectionString, max: 30, connectionTimeoutMillis: 5000 });

async function resetAndMigrate() {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await runMigrations(pool, { migrationsDirectory });
}

beforeEach(resetAndMigrate);

after(async () => {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await pool.end();
});

function candidate(date, suffix = "one") {
  const issue = createTestIssue(date, ["normal"]);
  delete issue.revision;
  issue.items[0].id = `item-${suffix}`;
  issue.items[0].title = `虚构标题 ${suffix}`;
  issue.items[0].brief = `虚构摘要 ${suffix}`;
  issue.items[0].summary = `只用于 M3-B 集成测试的虚构正文 ${suffix}`;
  issue.items[0].sources = [{ name: "Example", url: `https://example.com/fake/${date}/${suffix}` }];
  return issue;
}

async function fixture(options = {}) {
  const tenancy = new PostgresTenancyStore(pool);
  const tenant = await tenancy.ensureSpaceForUser(options.userId ?? "agent-api-user", defaults);
  const accessRepository = new PostgresAgentAccessRepository(pool, { rateLimitHours: 24, auditDays: 90 });
  const credentials = new AgentCredentialService(accessRepository, {
    tokenDigestSecret: digestSecret,
    pairingCodeDigestSecret: pairingSecret,
    activeCredentialLimit: 10,
    pairingCodeTtlSeconds: 600,
    provisioningTtlSeconds: 600,
    claimIpHourlyLimit: 20,
    verifyIpHourlyLimit: 40,
    apiBaseUrl: "https://dailynews.test/api/v1",
    mcpUrl: "https://dailynews.test/mcp",
    pairingVerifyUrl: "https://dailynews.test/agent-pairing/v1/verify",
  });
  const issued = await credentials.issueManualCredential(
    tenant,
    { name: "集成测试 Agent", operationId: randomUUID() },
    "req_fixture",
    keyedDigest(pairingSecret, "fixture-actor"),
  );
  assert.ok(issued.token);
  const policy = new PostgresAgentRequestPolicy(pool);
  const rateLimits = {
    digestSecret: pairingSecret,
    rateLimitRetentionHours: 24,
    readTokenHourlyLimit: options.readTokenHourlyLimit ?? 100,
    writeTokenHourlyLimit: options.writeTokenHourlyLimit ?? 100,
    readIpHourlyLimit: options.readIpHourlyLimit ?? 100,
    writeIpHourlyLimit: 100,
    credentialLastUsedTouchSeconds: 300,
  };
  const app = createCloudApp({
    basePath: "",
    readinessCheck: async () => {},
    clientIpResolver: () => "203.0.113.18",
    agentApi: {
      authenticator: new AgentRequestAuthenticator(credentials, tenancy, policy, rateLimits),
      operations: new AgentOperationsService(pool, tenancy, policy, {
        origin: "https://dailynews.test",
        basePath: "",
        dailyItemLimit: 100,
        todoOperationLimit: 100,
        concurrentWriteLimitPerSpace: options.concurrentWriteLimitPerSpace ?? 2,
        writeLeaseTtlSeconds: 300,
        submissionRetentionDays: 90,
      }, () => new Date("2026-08-27T04:00:00Z")),
      requestBodyLimitBytes: 262144,
    },
  });
  const headers = { authorization: `Bearer ${issued.token}` };
  return { app, headers, tenant, tenancy, credentials, credential: issued.credential, policy };
}

async function postJson(app, url, headers, key, body) {
  return app.request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

function assertDocumentedResponseFields(schemaName, payload) {
  const schema = openApi.components.schemas[schemaName];
  assert.ok(schema, `missing OpenAPI schema ${schemaName}`);
  for (const field of Object.keys(payload)) {
    assert.ok(schema.properties[field], `${schemaName} does not document response field ${field}`);
  }
  for (const field of schema.required ?? []) {
    assert.ok(Object.hasOwn(payload, field), `${schemaName} response is missing required field ${field}`);
  }
}

test("0102 upgrades short legacy Todo candidate IDs to independent valid clientRunIds", async () => {
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS app CASCADE");
  await pool.query(`
    CREATE SCHEMA app;
    CREATE TABLE app.schema_migrations (
      filename text PRIMARY KEY,
      checksum_sha256 character(64) NOT NULL,
      executed_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  const migrations = await discoverMigrations(migrationsDirectory);
  for (const migration of migrations.filter(({ sequence }) => sequence <= 101)) {
    await pool.query(migration.sql);
  }
  const tenancy = new PostgresTenancyStore(pool);
  const tenant = await tenancy.ensureSpaceForUser("legacy-todo-user", defaults);
  await pool.query(
    `INSERT INTO app.todo_submission_runs
       (space_id, candidate_id, payload_hash, candidate_payload, result_payload)
     VALUES ($1, 'x', $2, $3::jsonb, $4::jsonb)`,
    [tenant.spaceId, "a".repeat(64), JSON.stringify({ candidateId: "x" }), JSON.stringify({ result: "unchanged" })],
  );
  const migration = migrations.find(({ sequence }) => sequence === 102);
  assert.ok(migration);
  await pool.query(migration.sql);
  const upgraded = await pool.query(
    "SELECT candidate_id, client_run_id FROM app.todo_submission_runs WHERE space_id = $1",
    [tenant.spaceId],
  );
  assert.equal(upgraded.rows[0].candidate_id, "x");
  assert.match(upgraded.rows[0].client_run_id, /^legacy-[0-9a-f]{32}$/);
});

test("active PAT completes the Content JSON API loop with shared idempotency and formal reads", async () => {
  const { app, headers, tenant, credential } = await fixture();
  const publications = await app.request("https://dailynews.test/api/v1/publications", { headers });
  assert.equal(publications.status, 200);
  assert.deepEqual((await publications.json()).publications.map(({ publicationId }) => publicationId), ["daily-news"]);
  assert.ok((await pool.query("SELECT last_used_at FROM app.agent_credentials WHERE id = $1", [credential.id])).rows[0].last_used_at);

  const context = await app.request(
    "https://dailynews.test/api/v1/publications/daily-news/daily-context?date=2026-08-27",
    { headers },
  );
  assert.equal(context.status, 200);
  const contextBody = await context.json();
  assert.deepEqual(contextBody.issue, { exists: false, revision: null });
  assertDocumentedResponseFields("DailyContextResponse", contextBody);

  const body = {
    mode: "update",
    confirmation: { historicalDate: null, replace: null },
    candidate: candidate("2026-08-27"),
  };
  const created = await postJson(
    app,
    "https://dailynews.test/api/v1/publications/daily-news/daily-candidates",
    headers,
    "daily-api-run-0001",
    body,
  );
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.result, "created");
  assert.equal(createdBody.revision, 1);
  assert.equal(createdBody.pageUrl, "https://dailynews.test/p/daily-news/?date=2026-08-27");
  assertDocumentedResponseFields("DailySubmissionResponse", createdBody);

  const repeated = await postJson(
    app,
    "https://dailynews.test/api/v1/publications/daily-news/daily-candidates",
    headers,
    "daily-api-run-0001",
    structuredClone(body),
  );
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).revision, 1);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM app.daily_candidates WHERE space_id = $1", [tenant.spaceId])).rows[0].count, 1);

  const changed = structuredClone(body);
  changed.candidate.items[0].title = "不同正文";
  const conflict = await postJson(
    app,
    "https://dailynews.test/api/v1/publications/daily-news/daily-candidates",
    headers,
    "daily-api-run-0001",
    changed,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");

  const issue = await app.request(
    "https://dailynews.test/api/v1/publications/daily-news/issues/2026-08-27",
    { headers },
  );
  assert.equal(issue.status, 200);
  const issueBody = await issue.json();
  assert.equal(issueBody.issue.revision, 1);
  assert.equal(issueBody.compiledEdition.revision, 1);
});

test("Daily API enforces future, historical, replace revision, inactive, and tenant target boundaries", async () => {
  const first = await fixture({ userId: "daily-boundary-a" });
  const secondTenant = await first.tenancy.ensureSpaceForUser("daily-boundary-b", defaults);
  await pool.query(
    `INSERT INTO app.publications (space_id, publication_id, display_name, status, is_default, sort_order)
     VALUES ($1, 'private-b', 'Private B', 'active', false, 1)`,
    [secondTenant.spaceId],
  );
  await pool.query(
    `INSERT INTO app.publication_configs (space_id, publication_id, time_zone, priority_limits)
     VALUES ($1, 'private-b', 'UTC', $2::jsonb)`,
    [secondTenant.spaceId, JSON.stringify(defaults.priorityLimits)],
  );
  const hidden = await first.app.request(
    "https://dailynews.test/api/v1/publications/private-b/daily-context",
    { headers: first.headers },
  );
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.json()).error.code, "target_not_found");

  const future = await postJson(
    first.app,
    "https://dailynews.test/api/v1/publications/daily-news/daily-candidates",
    first.headers,
    "daily-future-run",
    { mode: "update", confirmation: { historicalDate: null, replace: null }, candidate: candidate("2026-08-28") },
  );
  assert.equal(future.status, 400);
  assert.equal((await future.json()).error.code, "future_date_not_allowed");

  const historicalBody = {
    mode: "update",
    confirmation: { historicalDate: null, replace: null },
    candidate: candidate("2026-08-26", "history"),
  };
  const unconfirmed = await postJson(first.app, "https://dailynews.test/api/v1/publications/daily-news/daily-candidates", first.headers, "daily-history-a", historicalBody);
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).error.code, "explicit_confirmation_required");
  historicalBody.confirmation.historicalDate = "2026-08-26";
  const confirmed = await postJson(first.app, "https://dailynews.test/api/v1/publications/daily-news/daily-candidates", first.headers, "daily-history-b", historicalBody);
  assert.equal(confirmed.status, 200);

  const initial = { mode: "update", confirmation: { historicalDate: null, replace: null }, candidate: candidate("2026-08-27", "initial") };
  assert.equal((await postJson(first.app, "https://dailynews.test/api/v1/publications/daily-news/daily-candidates", first.headers, "daily-replace-a", initial)).status, 200);
  const updated = structuredClone(initial);
  updated.candidate.items[0].title = "新 revision";
  assert.equal((await postJson(first.app, "https://dailynews.test/api/v1/publications/daily-news/daily-candidates", first.headers, "daily-replace-b", updated)).status, 200);
  const staleReplace = {
    mode: "replace",
    confirmation: { historicalDate: null, replace: { publicationId: "daily-news", date: "2026-08-27", expectedRevision: 1 } },
    candidate: candidate("2026-08-27", "replacement"),
  };
  const stale = await postJson(first.app, "https://dailynews.test/api/v1/publications/daily-news/daily-candidates", first.headers, "daily-replace-c", staleReplace);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "revision_conflict");

  const factsBeforeInactiveWrite = (await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM app.daily_candidates WHERE space_id = $1 AND publication_id = 'daily-news') AS candidate_count,
       (SELECT count(*)::integer FROM app.daily_submission_runs WHERE space_id = $1 AND publication_id = 'daily-news') AS submission_count,
       (SELECT max(revision)::integer FROM app.issues WHERE space_id = $1 AND publication_id = 'daily-news') AS issue_revision,
       (SELECT max(revision)::integer FROM app.compiled_editions WHERE space_id = $1 AND publication_id = 'daily-news') AS compiled_revision`,
    [first.tenant.spaceId],
  )).rows[0];
  await pool.query("UPDATE app.publications SET status = 'inactive' WHERE space_id = $1 AND publication_id = 'daily-news'", [first.tenant.spaceId]);
  const inactive = await postJson(first.app, "https://dailynews.test/api/v1/publications/daily-news/daily-candidates", first.headers, "daily-inactive-run", initial);
  assert.equal(inactive.status, 409);
  assert.equal((await inactive.json()).error.code, "publication_inactive");
  const factsAfterInactiveWrite = (await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM app.daily_candidates WHERE space_id = $1 AND publication_id = 'daily-news') AS candidate_count,
       (SELECT count(*)::integer FROM app.daily_submission_runs WHERE space_id = $1 AND publication_id = 'daily-news') AS submission_count,
       (SELECT max(revision)::integer FROM app.issues WHERE space_id = $1 AND publication_id = 'daily-news') AS issue_revision,
       (SELECT max(revision)::integer FROM app.compiled_editions WHERE space_id = $1 AND publication_id = 'daily-news') AS compiled_revision`,
    [first.tenant.spaceId],
  )).rows[0];
  assert.deepEqual(factsAfterInactiveWrite, factsBeforeInactiveWrite);
});

test("Todo API keeps disabled state private and uses clientRunId independently from candidateId", async () => {
  const { app, headers, tenant } = await fixture();
  await pool.query(
    `INSERT INTO app.todo_states (space_id, revision, state_payload)
     VALUES ($1, 1, $2::jsonb)`,
    [tenant.spaceId, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      updatedAt: "2026-08-26T08:00:00.000Z",
      items: [{
        id: "todo-1234abcd", title: "保留正文", status: "open",
        createdAt: "2026-08-26T08:00:00.000Z", updatedAt: "2026-08-26T08:00:00.000Z",
        completedAt: null, archivedAt: null,
      }],
    })],
  );
  const disabled = await app.request("https://dailynews.test/api/v1/todo", { headers });
  assert.equal(disabled.status, 200);
  const disabledText = await disabled.text();
  assert.doesNotMatch(disabledText, /保留正文|revision|items/);

  await pool.query("UPDATE app.todo_profiles SET enabled = true WHERE space_id = $1", [tenant.spaceId]);
  const candidateBody = {
    candidate: {
      schemaVersion: 1,
      candidateId: "todo-api-candidate",
      generatedAt: "2026-08-27T09:00:00+08:00",
      baseRevision: 1,
      operations: [{ type: "add", clientId: "one", title: "虚构新任务" }],
    },
  };
  const submitted = await postJson(app, "https://dailynews.test/api/v1/todo/candidates", headers, "todo-api-run-0001", candidateBody);
  assert.equal(submitted.status, 200);
  const submittedBody = await submitted.json();
  assert.equal(submittedBody.revision, 2);
  assertDocumentedResponseFields("TodoSubmissionResponse", submittedBody);
  const repeated = await postJson(app, "https://dailynews.test/api/v1/todo/candidates", headers, "todo-api-run-0001", structuredClone(candidateBody));
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).revision, 2);
  const stored = await pool.query("SELECT client_run_id, candidate_id FROM app.todo_submission_runs WHERE space_id = $1", [tenant.spaceId]);
  assert.deepEqual(stored.rows, [{ client_run_id: "todo-api-run-0001", candidate_id: "todo-api-candidate" }]);

  const changed = structuredClone(candidateBody);
  changed.candidate.operations[0].title = "不同任务";
  const conflict = await postJson(app, "https://dailynews.test/api/v1/todo/candidates", headers, "todo-api-run-0001", changed);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");

  const todo = await app.request("https://dailynews.test/api/v1/todo", { headers });
  assert.equal(todo.status, 200);
  const todoBody = await todo.json();
  assert.equal(todoBody.revision, 2);
  assert.equal(todoBody.state.items.length, 2);
});

test("persistent request limits, write leases, and revoked PATs fail closed", async () => {
  const limited = await fixture({ readTokenHourlyLimit: 1, concurrentWriteLimitPerSpace: 1 });
  assert.equal((await limited.app.request("https://dailynews.test/api/v1/publications", { headers: limited.headers })).status, 200);
  const rateLimited = await limited.app.request("https://dailynews.test/api/v1/publications", { headers: limited.headers });
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get("retry-after"), "3600");

  let release;
  const held = limited.policy.withWriteLease({
    tenant: limited.tenant,
    credentialId: limited.credential.id,
    requestId: "req_held",
    concurrentLimit: 1,
    ttlSeconds: 300,
  }, () => new Promise((resolve) => { release = resolve; }));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => limited.policy.withWriteLease({
      tenant: limited.tenant,
      credentialId: limited.credential.id,
      requestId: "req_second",
      concurrentLimit: 1,
      ttlSeconds: 300,
    }, async () => {}),
    (error) => error instanceof AgentRequestError && error.code === "rate_limited",
  );
  release();
  await held;

  await limited.credentials.revokeCredential(
    limited.tenant,
    limited.credential.id,
    "req_revoke",
    keyedDigest(pairingSecret, "revoke-actor"),
  );
  const revoked = await limited.app.request("https://dailynews.test/api/v1/todo", { headers: limited.headers });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).error.code, "invalid_token");
});

test("persistent IP limits aggregate different active PATs without storing the raw address", async () => {
  const limited = await fixture({ userId: "ip-rate-user", readIpHourlyLimit: 1 });
  assert.equal((await limited.app.request("https://dailynews.test/api/v1/publications", { headers: limited.headers })).status, 200);
  const second = await limited.credentials.issueManualCredential(
    limited.tenant,
    { name: "Second Agent", operationId: randomUUID() },
    "req_second_token",
    keyedDigest(pairingSecret, "second-token-actor"),
  );
  const response = await limited.app.request("https://dailynews.test/api/v1/publications", {
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(response.status, 429);
  const stored = await pool.query(
    "SELECT key_digest FROM app.agent_rate_limit_events WHERE action = 'api_read_ip'",
  );
  assert.equal(stored.rowCount, 1);
  assert.match(stored.rows[0].key_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.rows[0].key_digest, "203.0.113.18");
});
