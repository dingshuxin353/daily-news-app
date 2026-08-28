#!/usr/bin/env node

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import process from "node:process";

import {
  EvidenceInputError,
  readPrivateJson,
  readPrivateText,
  safeDate,
  safeError,
  safeErrorCode,
  safeIdentifier,
  safeRequestId,
  safeRevision,
  safeStatus,
  sha256,
  summarizeResponse,
  summarizeToolResult,
  summarizeTools,
  validRunId,
  writeEvidence,
} from "./lib/safe-evidence.js";

const ERAS = new Set(["modern", "legacy", "both"]);
const PHASES = new Set(["inspect", "daily", "todo", "full", "credential-cutover"]);
const CLIENT_RUN_ID = /^[A-Za-z0-9._-]{8,80}$/;
const PAT_FORMAT = /^dnpat_[A-Za-z0-9_-]+$/;

function usage() {
  return [
    "M3-E live MCP runner (credentials are read only from private files)",
    "",
    "Required environment:",
    "  M3E_MCP_URL                 MCP endpoint URL without query, hash, or userinfo",
    "  M3E_PAT_FILE                private regular file (mode 0600 or stricter) containing one PAT",
    "",
    "Optional environment:",
    "  M3E_PUBLICATION_ID          explicit Daily publication identifier",
    "  M3E_DAILY_CLIENT_RUN_ID     Daily idempotency key when submitting a candidate",
    "  M3E_TODO_CLIENT_RUN_ID      Todo idempotency key when submitting a candidate",
    "  M3E_JSON_API_URL            exact Daily JSON API candidate endpoint for cross-transport replay",
    "  M3E_OLD_PAT_FILE            revoked PAT file for credential-cutover phase",
    "  M3E_NEW_PAT_FILE            replacement PAT file for credential-cutover phase",
    "",
    "Usage:",
    "  node test/m3-e/run-live-mcp.js --phase inspect --era both",
    "  node test/m3-e/run-live-mcp.js --phase full --era modern --daily-file /private/path/daily.json --todo-file /private/path/todo.json",
    "  node test/m3-e/run-live-mcp.js --phase credential-cutover",
    "",
    "Candidate files and requirement files must be private regular files outside the repository.",
    "Evidence is written to ignored test-results/m3-e/ and contains summaries, hashes, status codes, and request IDs only.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { phase: "inspect", era: "modern" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!["--phase", "--era", "--daily-file", "--todo-file", "--requirements-file", "--run-id"].includes(argument)) {
      throw new EvidenceInputError("unknown_argument");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new EvidenceInputError("argument_value_required");
    options[argument.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  if (!PHASES.has(options.phase)) throw new EvidenceInputError("phase_invalid");
  if (!ERAS.has(options.era)) throw new EvidenceInputError("era_invalid");
  if (options.run_id && !validRunId(options.run_id)) throw new EvidenceInputError("run_id_invalid");
  return options;
}

function cleanUrl(value, purpose) {
  if (typeof value !== "string" || value.length === 0) throw new EvidenceInputError(`${purpose}_required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new EvidenceInputError(`${purpose}_invalid`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new EvidenceInputError(`${purpose}_invalid`);
  }
  return url;
}

function clientRunId(value, purpose) {
  if (typeof value !== "string" || !CLIENT_RUN_ID.test(value)) {
    throw new EvidenceInputError(`${purpose}_invalid`);
  }
  return value;
}

function extractPublicationId(result) {
  const value = result?.structuredContent?.publication?.publicationId;
  return safeIdentifier(value);
}

function extractDate(result) {
  return safeDate(result?.structuredContent?.resolvedDate)
    ?? safeDate(result?.structuredContent?.date);
}

function operationError(summary) {
  return summary.outcome === "error" || summary.protocolError === true;
}

async function callTool(client, operations, name, argumentsValue) {
  try {
    const result = await client.callTool({ name, arguments: argumentsValue });
    const summary = summarizeToolResult(name, result);
    operations.push(summary);
    return { result, summary };
  } catch (error) {
    const summary = {
      tool: name.replaceAll("_", "-"),
      outcome: "protocol_error",
      protocolError: true,
      ...safeError(error),
    };
    operations.push(summary);
    return { result: undefined, summary };
  }
}

async function readApiReplay(url, token, body) {
  try {
    const response = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": body.clientRunId,
      },
      body: JSON.stringify({
        mode: body.mode,
        confirmation: body.confirmation,
        candidate: body.candidate,
      }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const summary = {
      transport: "json-api",
      ...summarizeResponse(response),
    };
    const requestId = safeRequestId(payload?.requestId) ?? safeRequestId(payload?.error?.requestId);
    if (requestId) summary.bodyRequestId = requestId;
    const revision = safeRevision(payload?.revision);
    if (revision !== undefined) summary.revision = revision;
    if (typeof payload?.result === "string" && /^(?:created|updated|unchanged)$/.test(payload.result)) {
      summary.result = payload.result;
    }
    const errorCode = safeErrorCode(payload?.error?.code);
    if (errorCode) summary.errorCode = errorCode;
    return summary;
  } catch (error) {
    return { transport: "json-api", outcome: "transport_error", ...safeError(error) };
  }
}

async function runSession({ url, token, era, options, inputs }) {
  const transportEvents = [];
  const operations = [];
  const session = { era, connected: false, transportEvents, operations };
  const client = new Client(
    { name: "dailynews-m3e-real-client", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      try {
        const response = await globalThis.fetch(input, init);
        transportEvents.push(summarizeResponse(response));
        return response;
      } catch (error) {
        transportEvents.push({ outcome: "transport_error", ...safeError(error) });
        throw error;
      }
    },
  });

  try {
    await client.connect(transport);
    session.connected = true;
    const serverVersion = client.getServerVersion();
    session.server = {
      name: serverVersion?.name === "dailynews" ? "dailynews" : "unexpected",
      version: typeof serverVersion?.version === "string" && /^\d+\.\d+\.\d+$/.test(serverVersion.version)
        ? serverVersion.version
        : "unexpected",
      instructionsBytes: Buffer.byteLength(client.getInstructions?.() ?? "", "utf8"),
      instructionsSha256: sha256(client.getInstructions?.() ?? ""),
    };
    const listed = await client.listTools();
    session.tools = summarizeTools(listed.tools);

    let dailyContext;
    let todoContext;
    if (["inspect", "daily", "full"].includes(options.phase)) {
      const call = await callTool(client, operations, "get_daily_context", {});
      dailyContext = call.result;
    }
    if (["inspect", "todo", "full"].includes(options.phase)) {
      const call = await callTool(client, operations, "get_todo_context", {});
      todoContext = call.result;
    }

    if (["daily", "full"].includes(options.phase)) {
      if (!inputs.dailyCandidate) throw new EvidenceInputError("daily_candidate_required");
      const publicationId = process.env.M3E_PUBLICATION_ID || extractPublicationId(dailyContext);
      if (!safeIdentifier(publicationId)) throw new EvidenceInputError("publication_id_unavailable");
      const dailyRunId = clientRunId(process.env.M3E_DAILY_CLIENT_RUN_ID, "daily_client_run_id");
      const body = {
        publicationId,
        clientRunId: dailyRunId,
        mode: "update",
        confirmation: { historicalDate: null, replace: null },
        candidate: inputs.dailyCandidate,
      };
      const submitted = await callTool(client, operations, "submit_daily_candidate", body);
      const date = safeDate(inputs.dailyCandidate.date) ?? extractDate(submitted.result);
      if (safeIdentifier(publicationId) && date) {
        await callTool(client, operations, "get_daily_issue", { publicationId, date });
      }
      if (inputs.jsonApiUrl) {
        session.jsonApiReplay = await readApiReplay(inputs.jsonApiUrl, token, body);
      }
    }

    if (["todo", "full"].includes(options.phase)) {
      if (!inputs.todoCandidate) throw new EvidenceInputError("todo_candidate_required");
      const enabled = todoContext?.structuredContent?.enabled;
      if (enabled === false) {
        session.todoWriteSkipped = "todo_disabled";
      } else {
        const todoRunId = clientRunId(process.env.M3E_TODO_CLIENT_RUN_ID, "todo_client_run_id");
        await callTool(client, operations, "submit_todo_candidate", {
          clientRunId: todoRunId,
          candidate: inputs.todoCandidate,
        });
        await callTool(client, operations, "get_todo_state", {});
      }
    }
  } catch (error) {
    session.error = error instanceof EvidenceInputError ? { code: error.code } : safeError(error);
  } finally {
    try {
      await client.close();
    } catch {
      // Closing a failed transport must not expose an SDK error or alter evidence.
    }
  }
  session.failed = Boolean(session.error) || operations.some(operationError);
  return session;
}

async function runCredentialCutover({ url, oldToken, newToken }) {
  const probe = async (token, label) => {
    const result = await runSession({
      url,
      token,
      era: "modern",
      options: { phase: "inspect" },
      inputs: {},
    });
    const rejected = result.failed || result.operations.some(({ errorCode }) => errorCode === "invalid_token");
    return {
      label,
      accepted: !rejected && result.connected,
      rejected,
      transportStatuses: result.transportEvents.map(({ status }) => status).filter((status) => safeStatus(status) !== undefined),
      operations: result.operations,
    };
  };
  const oldProbe = await probe(oldToken, "revoked");
  const newProbe = await probe(newToken, "replacement");
  return {
    oldTokenRejected: oldProbe.rejected,
    newTokenAccepted: newProbe.accepted,
    probes: [oldProbe, newProbe],
    failed: !oldProbe.rejected || !newProbe.accepted,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const runId = options.run_id || `m3e-${Date.now()}-${process.pid}`;
  const evidence = {
    schemaVersion: 1,
    runId,
    phase: options.phase,
    startedAt: new Date().toISOString(),
    client: "@modelcontextprotocol/client@2.0.0",
  };

  if (options.phase === "credential-cutover") {
    const url = cleanUrl(process.env.M3E_MCP_URL, "mcp_url");
    const oldSource = await readPrivateText(process.env.M3E_OLD_PAT_FILE, "old_pat", 4 * 1024);
    const newSource = await readPrivateText(process.env.M3E_NEW_PAT_FILE, "new_pat", 4 * 1024);
    const oldToken = oldSource.text.trim();
    const newToken = newSource.text.trim();
    if (!PAT_FORMAT.test(oldToken) || !PAT_FORMAT.test(newToken) || oldToken === newToken) {
      throw new EvidenceInputError("pat_file_invalid");
    }
    evidence.credentialCutover = await runCredentialCutover({ url, oldToken, newToken });
  } else {
    const url = cleanUrl(process.env.M3E_MCP_URL, "mcp_url");
    const patSource = await readPrivateText(process.env.M3E_PAT_FILE, "pat", 4 * 1024);
    const token = patSource.text.trim();
    if (!PAT_FORMAT.test(token)) throw new EvidenceInputError("pat_file_invalid");

    const inputs = {};
    if (options.daily_file) inputs.dailyCandidate = (await readPrivateJson(options.daily_file, "daily_candidate")).value;
    if (options.todo_file) inputs.todoCandidate = (await readPrivateJson(options.todo_file, "todo_candidate")).value;
    if (options.requirements_file) {
      const requirements = await readPrivateText(options.requirements_file, "requirements", 128 * 1024);
      evidence.requirements = { bytes: requirements.bytes, sha256: sha256(requirements.text) };
    }
    if (process.env.M3E_JSON_API_URL) inputs.jsonApiUrl = cleanUrl(process.env.M3E_JSON_API_URL, "json_api_url");

    const eras = options.era === "both" ? ["modern", "legacy"] : [options.era];
    evidence.sessions = [];
    for (const era of eras) {
      evidence.sessions.push(await runSession({ url, token, era, options, inputs }));
    }
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.status = evidence.credentialCutover?.failed === true
    || evidence.sessions?.some((session) => session.failed)
    ? "failed"
    : "passed";
  const evidenceFile = await writeEvidence(runId, evidence);
  console.log(`[m3-e] status=${evidence.status} phase=${options.phase} evidence=${evidenceFile}`);
  if (evidence.status !== "passed") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const code = error instanceof EvidenceInputError ? error.code : "run_failed";
  console.error(`[m3-e] blocked=${code}`);
  process.exitCode = 2;
}
