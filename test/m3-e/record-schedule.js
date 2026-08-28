#!/usr/bin/env node

import process from "node:process";

import {
  EvidenceInputError,
  readPrivateJson,
  readPrivateText,
  sha256,
  validRunId,
  writeEvidence,
} from "./lib/safe-evidence.js";

const PHASES = new Set(["initial", "scheduled-repeat", "changed-requirement"]);
const TRIGGER_SOURCES = new Set(["agent-immediate", "codex-heartbeat"]);
const DIGEST = /^[0-9a-f]{64}$/;

function usage() {
  return [
    "M3-E scheduler evidence recorder",
    "",
    "Usage:",
    "  node test/m3-e/record-schedule.js --event-file /private/path/event.json --requirements-file /private/path/requirements.txt",
    "",
    "The event file must be a private regular JSON file outside the repository.",
    "It may contain only schedule facts; never put PATs, cookies, authorization headers, or user正文 in it.",
    "For scheduled-repeat and changed-requirement, triggerSource must be codex-heartbeat, automated must be true, and manualTrigger must be false.",
    "The recorder writes only a sanitized record under ignored test-results/m3-e/.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!["--event-file", "--requirements-file", "--run-id"].includes(argument)) {
      throw new EvidenceInputError("unknown_argument");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new EvidenceInputError("argument_value_required");
    options[argument.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  if (!options.event_file) throw new EvidenceInputError("event_file_required");
  if (options.run_id && !validRunId(options.run_id)) throw new EvidenceInputError("run_id_invalid");
  return options;
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.length === 0) throw new EvidenceInputError(code);
  return value;
}

function parseTimestamp(value, code) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new EvidenceInputError(code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new EvidenceInputError(code);
  return value;
}

function requireDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new EvidenceInputError(code);
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const event = (await readPrivateJson(options.event_file, "schedule_event", 32 * 1024)).value;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new EvidenceInputError("schedule_event_invalid");
  }
  const phase = requiredString(event.phase, "schedule_phase_required");
  if (!PHASES.has(phase)) throw new EvidenceInputError("schedule_phase_invalid");
  const triggerSource = requiredString(event.triggerSource, "trigger_source_required");
  if (!TRIGGER_SOURCES.has(triggerSource)) throw new EvidenceInputError("trigger_source_invalid");
  const scheduledAt = parseTimestamp(event.scheduledAt, "scheduled_at_invalid");
  const triggeredAt = parseTimestamp(event.triggeredAt, "triggered_at_invalid");
  if (Date.parse(triggeredAt) < Date.parse(scheduledAt)) throw new EvidenceInputError("trigger_before_schedule");
  const mcpRunId = requiredString(event.mcpRunId, "mcp_run_id_required");
  if (!validRunId(mcpRunId)) throw new EvidenceInputError("mcp_run_id_invalid");
  if (phase !== "initial" && (event.automated !== true || event.manualTrigger !== false)) {
    throw new EvidenceInputError("schedule_must_be_automated");
  }
  if (phase !== "initial" && triggerSource !== "codex-heartbeat") {
    throw new EvidenceInputError("scheduled_phase_requires_heartbeat");
  }

  let requirementSha256 = event.requirementSha256 === undefined
    ? undefined
    : requireDigest(event.requirementSha256, "requirement_digest_invalid");
  let requirementBytes;
  if (options.requirements_file) {
    const requirements = await readPrivateText(options.requirements_file, "requirements", 128 * 1024);
    requirementSha256 = sha256(requirements.text);
    requirementBytes = requirements.bytes;
    if (event.requirementSha256 && event.requirementSha256 !== requirementSha256) {
      throw new EvidenceInputError("requirement_digest_mismatch");
    }
  }
  if (!requirementSha256) throw new EvidenceInputError("requirement_digest_required");

  const runId = options.run_id || `schedule-${Date.now()}-${process.pid}`;
  const evidence = {
    schemaVersion: 1,
    runId,
    kind: "schedule-event",
    phase,
    triggerSource,
    automated: event.automated === true,
    manualTrigger: event.manualTrigger === true,
    scheduledAt,
    triggeredAt,
    mcpRunId,
    requirementSha256,
    ...(requirementBytes === undefined ? {} : { requirementBytes }),
    recordedAt: new Date().toISOString(),
  };
  const evidenceFile = await writeEvidence(runId, evidence);
  console.log(`[m3-e] status=recorded phase=${phase} evidence=${evidenceFile}`);
}

try {
  await main();
} catch (error) {
  const code = error instanceof EvidenceInputError ? error.code : "record_failed";
  console.error(`[m3-e] blocked=${code}`);
  process.exitCode = 2;
}
