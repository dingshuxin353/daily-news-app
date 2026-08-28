import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EvidenceInputError,
  redact,
  readPrivateJson,
  readPrivateText,
  safeRequestId,
  STANDALONE_SCHEDULER,
  summarizeToolResult,
  summarizeTools,
  validateScheduleEvent,
} from "./m3-e/lib/safe-evidence.js";

async function privateFixture(name, contents, mode = 0o600) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dailynews-m3e-"));
  const file = path.join(directory, name);
  await writeFile(file, contents, { encoding: "utf8", mode });
  await chmod(file, mode);
  return { directory, file };
}

test("M3-E evidence summaries keep response bodies and credential material out", () => {
  const fakePat = ["dnpat", "selector", "secret"].join("_");
  const summary = summarizeToolResult("get_daily_issue", {
    isError: false,
    structuredContent: {
      requestId: "req_0123456789abcdef0123456789abcdef",
      publicationId: "daily-news",
      date: "2026-08-28",
      revision: 4,
      issue: { revision: 4, title: "private title" },
      body: "private body",
      authorization: `Bearer ${fakePat}`,
    },
  });
  const serialized = JSON.stringify(summary);
  assert.equal(summary.requestId, "req_0123456789abcdef0123456789abcdef");
  assert.equal(summary.revision, 4);
  assert.doesNotMatch(serialized, /private title|private body|dnpat_|Bearer/);
  assert.equal(safeRequestId("not-a-request-id"), undefined);
});

test("redaction replaces PATs and bearer values without exposing their suffixes", () => {
  const fakePat = ["dnpat", "abcdefghijklmnopqrstuvwxyz", "0123456789-SECRET"].join("_");
  const value = redact({
    authorization: `Bearer ${fakePat}`,
    nested: fakePat,
  });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /dnpat_|SECRET|Bearer\s+[^[]/);
  assert.match(serialized, /REDACTED/);
});

test("tool summaries keep unexpected server-provided names and error codes out", () => {
  const unexpectedTool = ["dnpat", "server", "provided"].join("_");
  const tools = summarizeTools([
    { name: "get_daily_context" },
    { name: unexpectedTool },
  ]);
  assert.deepEqual(tools.names, ["get_daily_context"]);
  assert.equal(tools.unexpectedCount, 1);
  assert.doesNotMatch(JSON.stringify(tools), /dnpat|server-provided/);
  assert.equal(summarizeToolResult("get_daily_context", {
    isError: true,
    structuredContent: { error: { code: unexpectedTool } },
  }).errorCode, undefined);
});

test("schedule evidence only accepts a standalone cron task and its new session", async () => {
  const valid = {
    phase: "scheduled-repeat",
    schedulerType: STANDALONE_SCHEDULER,
    automated: true,
    manualTrigger: false,
    scheduledAt: "2026-08-30T09:00:00+09:00",
    startedAt: "2026-08-30T09:00:03+09:00",
    taskId: "m3e-task-20260830-090003",
    sessionId: "m3e-session-20260830-090003",
    mcpRunId: "m3e-run-20260830-090003",
    requestId: "req_0123456789abcdef0123456789abcdef",
    formalRevision: 2,
  };
  assert.deepEqual(validateScheduleEvent(valid), valid);
  const fixture = await privateFixture("scheduled-repeat.json", JSON.stringify(valid));
  try {
    const parsed = await readPrivateJson(fixture.file, "schedule_event");
    assert.deepEqual(validateScheduleEvent(parsed.value), valid);
    assert.equal(redact({ sessionId: valid.sessionId }).sessionId, valid.sessionId);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
  const legacyScheduler = ["codex", "legacy", "scheduler"].join("-");
  assert.throws(
    () => validateScheduleEvent({ ...valid, schedulerType: legacyScheduler }),
    (error) => error instanceof EvidenceInputError && error.code === "scheduler_type_invalid",
  );
  assert.throws(
    () => validateScheduleEvent({ ...valid, triggerSource: "manual" }),
    (error) => error instanceof EvidenceInputError && error.code === "schedule_legacy_field_not_allowed",
  );
  assert.throws(
    () => validateScheduleEvent({ ...valid, manualTrigger: true }),
    (error) => error instanceof EvidenceInputError && error.code === "schedule_must_be_automated",
  );
});

test("private input files must be regular repository-external files with restrictive modes", async () => {
  const fixture = await privateFixture("requirements.txt", "follow AI policy updates\n");
  try {
    const result = await readPrivateText(fixture.file, "requirements");
    assert.equal(result.text, "follow AI policy updates\n");
    await chmod(fixture.file, 0o644);
    await assert.rejects(
      () => readPrivateText(fixture.file, "requirements"),
      (error) => error instanceof EvidenceInputError && error.code === "requirements_file_permissions_must_be_private",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("JSON evidence inputs reject sensitive keys before any evidence is written", async () => {
  const fakePat = ["dnpat", "selector", "secret"].join("_");
  const fixture = await privateFixture("event.json", JSON.stringify({
    phase: "scheduled-repeat",
    authorization: `Bearer ${fakePat}`,
  }));
  try {
    await assert.rejects(
      () => readPrivateJson(fixture.file, "schedule_event"),
      (error) => error instanceof EvidenceInputError && error.code === "schedule_event_contains_sensitive_field",
    );
    assert.equal(await readFile(fixture.file, "utf8"), JSON.stringify({
      phase: "scheduled-repeat",
      authorization: `Bearer ${fakePat}`,
    }));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
