import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { afterEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createProbeCandidate } from "../test-support/mcp-probe/fixture.js";
import { createMcpProbeHttpServer } from "../test-support/mcp-probe/http.js";
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION } from "../test-support/mcp-probe/probe.js";

const tokens = {
  codex: "codex-test-token-not-secret",
  workbuddy: "workbuddy-test-token-not-secret",
  revoked: "revoked-test-token-not-secret",
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serverOptions(logs = []) {
  return {
    activeTokenDigests: Object.fromEntries(
      Object.entries(tokens).map(([clientId, token]) => [clientId, digest(token)]),
    ),
    revokedTokenDigests: [digest(tokens.revoked)],
    allowedOrigins: ["https://allowed.example"],
    logger: (event) => logs.push(event),
  };
}

async function listen(options = serverOptions()) {
  const server = createMcpProbeHttpServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    url: new URL(`http://127.0.0.1:${address.port}/mcp-test`),
  };
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function connect(url, token, extraHeaders = {}) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
    },
  });
  const client = new Client({ name: "dailynews-probe-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function initializeBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "raw-probe-test", version: "1.0.0" },
    },
  };
}

async function rawRequest(url, { authorization, body = initializeBody(), headers = {} } = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const openClients = new Set();
const openServers = new Set();

async function trackedListen(options) {
  const result = await listen(options);
  openServers.add(result.server);
  return result;
}

async function trackedConnect(...args) {
  const result = await connect(...args);
  openClients.add(result.client);
  return result;
}

afterEach(async () => {
  await Promise.allSettled([...openClients].map((client) => client.close()));
  openClients.clear();
  await Promise.allSettled([...openServers].map((server) => closeServer(server)));
  openServers.clear();
});

describe("DailyNews MCP compatibility probe", () => {
  test("negotiates 2025-11-25 and exposes only the three probe tools", async () => {
    const { url } = await trackedListen();
    const { client, transport } = await trackedConnect(url, tokens.codex);

    assert.equal(transport.protocolVersion, PROTOCOL_VERSION);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "dailynews_get_probe_context",
        "dailynews_submit_probe",
        "dailynews_get_probe_receipt",
      ],
    );
    assert.deepEqual(tools[0].annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(tools[1].annotations.readOnlyHint, false);

    const submitInput = tools[1].inputSchema;
    assert.equal(submitInput.type, "object");
    assert.equal(submitInput.additionalProperties, false);
    assert.deepEqual(submitInput.required, ["clientRunId", "candidate"]);
    assert.deepEqual(submitInput.properties.clientRunId, {
      type: "string",
      minLength: 8,
      maxLength: 80,
      pattern: "^[A-Za-z0-9._-]+$",
    });

    const candidateInput = submitInput.properties.candidate;
    assert.equal(candidateInput.type, "object");
    assert.equal(candidateInput.additionalProperties, false);
    assert.deepEqual(Object.keys(candidateInput.properties), [
      "schemaVersion",
      "date",
      "generatedAt",
      "coverage",
      "items",
    ]);
    assert.deepEqual(candidateInput.required, [
      "schemaVersion",
      "date",
      "generatedAt",
      "coverage",
      "items",
    ]);
    assert.deepEqual(candidateInput.properties.schemaVersion, {
      type: "number",
      const: 1,
    });
    assert.equal(candidateInput.properties.date.format, "date");
    assert.equal(candidateInput.properties.generatedAt.format, "date-time");

    const coverageInput = candidateInput.properties.coverage;
    assert.equal(coverageInput.type, "object");
    assert.equal(coverageInput.additionalProperties, false);
    assert.deepEqual(coverageInput.required, ["start", "end"]);
    assert.equal(coverageInput.properties.start.format, "date-time");
    assert.equal(coverageInput.properties.end.format, "date-time");

    const itemsInput = candidateInput.properties.items;
    assert.equal(itemsInput.type, "array");
    assert.equal(itemsInput.minItems, 1);
    assert.equal(itemsInput.items.type, "object");
    assert.equal(itemsInput.items.additionalProperties, false);
    assert.deepEqual(Object.keys(itemsInput.items.properties), [
      "id",
      "title",
      "brief",
      "summary",
      "category",
      "editorial",
      "sources",
    ]);
    assert.deepEqual(itemsInput.items.required, [
      "id",
      "title",
      "brief",
      "summary",
      "editorial",
      "sources",
    ]);
    assert.equal(itemsInput.items.properties.category.type, "string");

    const editorialInput = itemsInput.items.properties.editorial;
    assert.equal(editorialInput.type, "object");
    assert.deepEqual(editorialInput.required, ["priority", "selectionReason"]);
    assert.deepEqual(editorialInput.properties.priority.enum, ["lead", "important", "normal"]);

    const sourcesInput = itemsInput.items.properties.sources;
    assert.equal(sourcesInput.type, "array");
    assert.equal(sourcesInput.minItems, 1);
    assert.equal(sourcesInput.items.additionalProperties, false);
    assert.deepEqual(Object.keys(sourcesInput.items.properties), [
      "originalTitle",
      "name",
      "url",
      "publishedAt",
      "discoveredAt",
      "via",
    ]);
    assert.deepEqual(sourcesInput.items.required, ["name", "url"]);
    assert.equal(sourcesInput.items.properties.url.format, "uri");
    assert.equal(sourcesInput.items.properties.publishedAt.format, "date-time");
    assert.equal(sourcesInput.items.properties.discoveredAt.format, "date-time");
    assert.equal(sourcesInput.items.properties.via.additionalProperties, false);
    assert.deepEqual(Object.keys(sourcesInput.items.properties.via.properties), ["name", "url"]);
    assert.deepEqual(sourcesInput.items.properties.via.required, ["name", "url"]);

    const context = await client.callTool({ name: "dailynews_get_probe_context", arguments: {} });
    assert.equal(context.isError, undefined);
    assert.equal(context.structuredContent.clientId, "codex");
    assert.equal(context.structuredContent.protocolVersion, PROTOCOL_VERSION);
    assert.equal(context.structuredContent.limits.maxRequestBytes, MAX_REQUEST_BYTES);
  });

  test("negotiates the fixed protocol when a client proposes an older version", async () => {
    const { url } = await trackedListen();
    const body = initializeBody();
    body.params.protocolVersion = "2025-06-18";

    const response = await rawRequest(url, {
      authorization: `Bearer ${tokens.codex}`,
      body,
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result.protocolVersion, PROTOCOL_VERSION);
  });

  test("submits, reads, deduplicates, and rejects an idempotency conflict", async () => {
    const { url } = await trackedListen();
    const { client } = await trackedConnect(url, tokens.codex);
    const candidate = createProbeCandidate();
    const args = { clientRunId: "codex-manual-20260822-01", candidate };

    const first = await client.callTool({ name: "dailynews_submit_probe", arguments: args });
    assert.equal(first.isError, undefined);
    assert.equal(first.structuredContent.duplicate, false);
    assert.equal(first.structuredContent.clientId, "codex");

    const duplicate = await client.callTool({ name: "dailynews_submit_probe", arguments: args });
    assert.equal(duplicate.structuredContent.receiptId, first.structuredContent.receiptId);
    assert.equal(duplicate.structuredContent.duplicate, true);

    const receipt = await client.callTool({
      name: "dailynews_get_probe_receipt",
      arguments: { receiptId: first.structuredContent.receiptId },
    });
    assert.deepEqual(receipt.structuredContent.candidate, candidate);
    assert.equal(receipt.structuredContent.duplicate, false);

    const changed = createProbeCandidate();
    changed.items[0].brief = "Different synthetic content.";
    const conflict = await client.callTool({
      name: "dailynews_submit_probe",
      arguments: { ...args, candidate: changed },
    });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /already used/);
  });

  test("derives identity from the token and isolates receipts between clients", async () => {
    const { url } = await trackedListen();
    const { client: codex } = await trackedConnect(url, tokens.codex);
    const { client: workbuddy } = await trackedConnect(url, tokens.workbuddy);

    const overrideAttempt = await codex.callTool({
      name: "dailynews_submit_probe",
      arguments: {
        clientId: "workbuddy",
        clientRunId: "shared-run-20260822",
        candidate: createProbeCandidate(),
      },
    });
    assert.equal(overrideAttempt.isError, true);
    assert.doesNotMatch(JSON.stringify(overrideAttempt), /DailyNews MCP Probe Fixture/);

    const submitted = await codex.callTool({
      name: "dailynews_submit_probe",
      arguments: {
        clientRunId: "shared-run-20260822",
        candidate: createProbeCandidate(),
      },
    });
    assert.equal(submitted.structuredContent.clientId, "codex");

    const hidden = await workbuddy.callTool({
      name: "dailynews_get_probe_receipt",
      arguments: { receiptId: submitted.structuredContent.receiptId },
    });
    assert.equal(hidden.isError, true);

    const own = await workbuddy.callTool({
      name: "dailynews_submit_probe",
      arguments: {
        clientRunId: "shared-run-20260822",
        candidate: createProbeCandidate(),
      },
    });
    assert.equal(own.structuredContent.clientId, "workbuddy");
    assert.notEqual(own.structuredContent.receiptId, submitted.structuredContent.receiptId);
  });

  test("rejects missing, wrong, malformed, and revoked bearer tokens", async () => {
    const { url } = await trackedListen();
    const authorizations = [
      undefined,
      "Bearer wrong-test-token",
      `Basic ${tokens.codex}`,
      `Bearer ${tokens.revoked}`,
    ];

    for (const authorization of authorizations) {
      const response = await rawRequest(url, { authorization });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }
  });

  test("rejects invalid Candidate fields and clientRunId without echoing the body", async () => {
    const { url } = await trackedListen();
    const { client } = await trackedConnect(url, tokens.codex);
    const invalidCases = [];

    const invalidDate = createProbeCandidate();
    invalidDate.date = "2026-02-30";
    invalidCases.push({ clientRunId: "invalid-date-01", candidate: invalidDate });

    const emptyItems = createProbeCandidate();
    emptyItems.items = [];
    invalidCases.push({ clientRunId: "empty-items-01", candidate: emptyItems });

    invalidCases.push({ clientRunId: "x".repeat(81), candidate: createProbeCandidate() });

    for (const argumentsValue of invalidCases) {
      const response = await client.callTool({
        name: "dailynews_submit_probe",
        arguments: argumentsValue,
      });
      assert.equal(response.isError, true);
      const serialized = JSON.stringify(response);
      assert.doesNotMatch(serialized, /DailyNews MCP Probe Fixture/);
      assert.doesNotMatch(serialized, /emoji/);
    }
  });

  test("rejects requests larger than 256 KiB", async () => {
    const { url } = await trackedListen();
    const response = await rawRequest(url, {
      authorization: `Bearer ${tokens.codex}`,
      body: JSON.stringify(initializeBody()) + "x".repeat(MAX_REQUEST_BYTES),
    });
    assert.equal(response.status, 413);
  });

  test("rejects disallowed Origin while accepting native clients without Origin", async () => {
    const { url } = await trackedListen();
    const rejected = await rawRequest(url, {
      authorization: `Bearer ${tokens.codex}`,
      headers: { origin: "https://blocked.example" },
    });
    assert.equal(rejected.status, 403);

    const { client } = await trackedConnect(url, tokens.codex);
    const context = await client.callTool({ name: "dailynews_get_probe_context", arguments: {} });
    assert.equal(context.structuredContent.clientId, "codex");
  });

  test("returns 405 for authenticated GET requests", async () => {
    const { url } = await trackedListen();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${tokens.codex}` },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  });

  test("logs only the approved metadata and never logs credentials or Candidate content", async () => {
    const logs = [];
    const { url } = await trackedListen(serverOptions(logs));
    const { client } = await trackedConnect(url, tokens.codex);
    await client.callTool({
      name: "dailynews_submit_probe",
      arguments: { clientRunId: "codex-log-test-01", candidate: createProbeCandidate() },
    });
    const invalid = await client.callTool({
      name: "dailynews_submit_probe",
      arguments: { clientRunId: "short", candidate: {} },
    });
    assert.equal(invalid.isError, true);

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(logs.length >= 2);
    for (const event of logs) {
      assert.deepEqual(Object.keys(event).sort(), [
        "clientId",
        "durationMs",
        "protocolVersion",
        "requestId",
        "result",
        "tool",
      ]);
    }
    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, new RegExp(tokens.codex));
    assert.doesNotMatch(serialized, /Authorization/i);
    assert.doesNotMatch(serialized, /DailyNews MCP Probe Fixture/);
    assert.doesNotMatch(serialized, /emoji/);
    assert.ok(
      logs.some(
        (event) => event.tool === "dailynews_submit_probe" && event.result === "validation_error",
      ),
    );
  });

  test("reinitializes after restart and intentionally loses in-memory receipts", async () => {
    const firstServer = await trackedListen();
    const { client: firstClient } = await trackedConnect(firstServer.url, tokens.codex);
    const submitted = await firstClient.callTool({
      name: "dailynews_submit_probe",
      arguments: { clientRunId: "codex-restart-01", candidate: createProbeCandidate() },
    });
    await firstClient.close();
    openClients.delete(firstClient);
    await closeServer(firstServer.server);
    openServers.delete(firstServer.server);

    const secondServer = await trackedListen();
    const { client: secondClient, transport } = await trackedConnect(secondServer.url, tokens.codex);
    assert.equal(transport.protocolVersion, PROTOCOL_VERSION);
    const missing = await secondClient.callTool({
      name: "dailynews_get_probe_receipt",
      arguments: { receiptId: submitted.structuredContent.receiptId },
    });
    assert.equal(missing.isError, true);
  });
});
