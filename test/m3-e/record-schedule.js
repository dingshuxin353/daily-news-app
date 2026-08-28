#!/usr/bin/env node

import process from "node:process";

import {
  EvidenceInputError,
  readPrivateJson,
  readPrivateText,
  sha256,
  validateScheduleEvent,
  validRunId,
  writeEvidence,
} from "./lib/safe-evidence.js";

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
    "Only schedulerType=codex-standalone-cron is accepted; it must create a new local task/session at the scheduled time.",
    "automated must be true and manualTrigger must be false; taskId, sessionId, startedAt, requestId, and formalRevision are required.",
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
  const schedule = validateScheduleEvent(event);

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
    ...schedule,
    requirementSha256,
    ...(requirementBytes === undefined ? {} : { requirementBytes }),
    recordedAt: new Date().toISOString(),
  };
  const evidenceFile = await writeEvidence(runId, evidence);
  console.log(`[m3-e] status=recorded phase=${schedule.phase} evidence=${evidenceFile}`);
}

try {
  await main();
} catch (error) {
  const code = error instanceof EvidenceInputError ? error.code : "record_failed";
  console.error(`[m3-e] blocked=${code}`);
  process.exitCode = 2;
}
