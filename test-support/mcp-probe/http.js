import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  createProbeMcpServer,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  ProbeReceiptStore,
  validateProbeSubmission,
} from "./probe.js";

const ENDPOINT = "/mcp-test";

function tokenDigest(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createTokenVerifier({ activeTokenDigests, revokedTokenDigests = [] }) {
  const clientsByDigest = new Map(
    Object.entries(activeTokenDigests).map(([clientId, digest]) => [digest, clientId]),
  );
  const revoked = new Set(revokedTokenDigests);

  return (authorization) => {
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    if (!match) return null;
    const digest = tokenDigest(match[1]);
    if (revoked.has(digest)) return null;
    const clientId = clientsByDigest.get(digest);
    return clientId ? { clientId } : null;
  };
}

export function createJsonLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  return (event) => write(JSON.stringify(event));
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function sendHttpError(response, statusCode, message, extraHeaders) {
  sendJson(
    response,
    statusCode,
    {
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    },
    extraHeaders,
  );
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    request.resume();
    return { tooLarge: true };
  }

  let size = 0;
  let tooLarge = false;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) return { tooLarge: true };

  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { invalidJson: true };
  }
}

function acceptsMcpResponse(header) {
  const value = header ?? "";
  return value.includes("application/json") && value.includes("text/event-stream");
}

function requestProtocolVersion(body, header) {
  if (body?.method === "initialize") {
    return body?.params?.protocolVersion;
  }
  return typeof header === "string" ? header : undefined;
}

export function createMcpProbeHttpServer({
  activeTokenDigests,
  revokedTokenDigests = [],
  allowedOrigins = [],
  logger = createJsonLogger(),
  store = new ProbeReceiptStore(),
}) {
  const verifyToken = createTokenVerifier({ activeTokenDigests, revokedTokenDigests });

  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const requestId = randomUUID();
    let clientId = null;
    let tool = null;
    let result = "http_error";
    let protocolVersion = null;

    response.once("finish", () => {
      logger({
        requestId,
        clientId,
        tool,
        result,
        durationMs: Math.round(performance.now() - startedAt),
        protocolVersion,
      });
    });

    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== ENDPOINT || url.search) {
        sendHttpError(response, 404, "Not found.");
        return;
      }

      const origin = request.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        sendHttpError(response, 403, "Origin is not allowed.");
        return;
      }

      const identity = verifyToken(request.headers.authorization);
      if (!identity) {
        result = "unauthorized";
        sendHttpError(response, 401, "Authentication required.", {
          "www-authenticate": "Bearer",
        });
        return;
      }
      clientId = identity.clientId;

      if (request.method !== "POST") {
        result = "method_not_allowed";
        sendHttpError(response, 405, "Method not allowed.", { allow: "POST" });
        return;
      }

      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        result = "unsupported_media_type";
        sendHttpError(response, 415, "Content-Type must be application/json.");
        return;
      }
      if (!acceptsMcpResponse(request.headers.accept)) {
        result = "not_acceptable";
        sendHttpError(response, 406, "Accept must include application/json and text/event-stream.");
        return;
      }

      const parsed = await readJsonBody(request);
      if (parsed.tooLarge) {
        result = "request_too_large";
        sendHttpError(response, 413, "Request body exceeds the 256 KiB probe limit.");
        return;
      }
      if (parsed.invalidJson) {
        result = "invalid_json";
        sendHttpError(response, 400, "Request body must be valid JSON.");
        return;
      }

      protocolVersion = requestProtocolVersion(parsed.body, request.headers["mcp-protocol-version"]);
      if (protocolVersion !== PROTOCOL_VERSION) {
        result = "unsupported_protocol";
        sendHttpError(response, 400, `This probe requires MCP protocol ${PROTOCOL_VERSION}.`);
        return;
      }

      if (parsed.body?.method === "tools/call") {
        tool = typeof parsed.body?.params?.name === "string" ? parsed.body.params.name : null;
        if (
          tool === "dailynews_submit_probe" &&
          !validateProbeSubmission(parsed.body?.params?.arguments).success
        ) {
          result = "validation_error";
        }
      } else if (typeof parsed.body?.method === "string") {
        tool = parsed.body.method;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcpServer = createProbeMcpServer({
        clientId,
        protocolVersion,
        store,
        onToolCall: (calledTool, callResult) => {
          tool = calledTool;
          result = callResult;
        },
      });

      response.once("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, parsed.body);
      if (result === "http_error") result = "success";
    } catch {
      result = "internal_error";
      sendHttpError(response, 500, "Internal server error.");
    }
  });
}
