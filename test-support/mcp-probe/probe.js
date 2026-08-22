import { createHash, randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

export const PROBE_NAME = "dailynews-mcp-probe";
export const PROBE_VERSION = "0.1.0";
export const PROTOCOL_VERSION = "2025-11-25";
export const MAX_REQUEST_BYTES = 256 * 1024;

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const sourceSchema = z.strictObject({
  originalTitle: z.string().min(1).optional(),
  name: z.string().min(1),
  url: z.url(),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  discoveredAt: z.iso.datetime({ offset: true }).optional(),
  via: z
    .strictObject({
      name: z.string().min(1),
      url: z.url(),
    })
    .optional(),
});

export const candidateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  date: z.iso.date(),
  generatedAt: z.iso.datetime({ offset: true }),
  coverage: z.strictObject({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  }),
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        title: z.string().min(1),
        brief: z.string().min(1),
        summary: z.string().min(1),
        category: z.string().min(1).optional(),
        editorial: z.strictObject({
          priority: z.enum(["lead", "important", "normal"]),
          selectionReason: z.string().min(1),
        }),
        sources: z.array(sourceSchema).min(1),
      }),
    )
    .min(1),
});

const submitSchema = z.strictObject({
  clientRunId: z.string().min(8).max(80).regex(/^[A-Za-z0-9._-]+$/),
  candidate: candidateSchema,
});

export function validateProbeSubmission(input) {
  return submitSchema.safeParse(input);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function candidateDigest(candidate) {
  return createHash("sha256").update(canonicalJson(candidate)).digest("hex");
}

function success(message, structuredContent) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
  };
}

function failure(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export class ProbeReceiptStore {
  #byId = new Map();
  #byIdempotencyKey = new Map();

  submit({ clientId, clientRunId, candidate, protocolVersion }) {
    const idempotencyKey = `${clientId}\0${clientRunId}`;
    const digest = candidateDigest(candidate);
    const existingId = this.#byIdempotencyKey.get(idempotencyKey);

    if (existingId) {
      const existing = this.#byId.get(existingId);
      if (existing.candidateDigest !== digest) {
        return { conflict: true };
      }
      return { receipt: { ...structuredClone(existing.receipt), duplicate: true } };
    }

    const receiptId = randomUUID();
    const receipt = {
      receiptId,
      clientRunId,
      clientId,
      duplicate: false,
      receivedAt: new Date().toISOString(),
      protocolVersion,
      candidate: structuredClone(candidate),
    };
    this.#byId.set(receiptId, { candidateDigest: digest, receipt });
    this.#byIdempotencyKey.set(idempotencyKey, receiptId);
    return { receipt: structuredClone(receipt) };
  }

  get({ clientId, receiptId }) {
    const entry = this.#byId.get(receiptId);
    if (!entry || entry.receipt.clientId !== clientId) {
      return null;
    }
    return structuredClone(entry.receipt);
  }
}

function validationFailure(result) {
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "input"))];
  return failure(`Invalid probe input. Check: ${fields.join(", ")}.`);
}

export function createProbeMcpServer({ clientId, protocolVersion, store, onToolCall }) {
  const server = new McpServer({ name: PROBE_NAME, version: PROBE_VERSION });

  server.registerTool(
    "dailynews_get_probe_context",
    {
      description: "Return the compatibility probe version, client identity, protocol, and test limits.",
      annotations,
    },
    async () => {
      onToolCall?.("dailynews_get_probe_context", "success");
      return success("DailyNews MCP compatibility probe is ready.", {
        probeVersion: PROBE_VERSION,
        serverTime: new Date().toISOString(),
        protocolVersion,
        clientId,
        limits: {
          maxRequestBytes: MAX_REQUEST_BYTES,
          clientRunIdPattern: "^[A-Za-z0-9._-]+$",
          clientRunIdMinLength: 8,
          clientRunIdMaxLength: 80,
          storage: "in-memory",
        },
      });
    },
  );

  server.registerTool(
    "dailynews_submit_probe",
    {
      description: "Validate and temporarily store a synthetic DailyNews Candidate for compatibility testing.",
      inputSchema: submitSchema,
      annotations: { ...annotations, readOnlyHint: false },
    },
    async (input) => {
      const parsed = validateProbeSubmission(input);
      if (!parsed.success) {
        onToolCall?.("dailynews_submit_probe", "validation_error");
        return validationFailure(parsed);
      }

      const result = store.submit({
        clientId,
        clientRunId: parsed.data.clientRunId,
        candidate: parsed.data.candidate,
        protocolVersion,
      });
      if (result.conflict) {
        onToolCall?.("dailynews_submit_probe", "conflict");
        return failure("This clientRunId was already used with different Candidate data. Use a new clientRunId.");
      }

      onToolCall?.("dailynews_submit_probe", result.receipt.duplicate ? "duplicate" : "success");
      return success(
        result.receipt.duplicate ? "Existing probe receipt returned." : "Probe Candidate accepted.",
        result.receipt,
      );
    },
  );

  server.registerTool(
    "dailynews_get_probe_receipt",
    {
      description: "Read a probe receipt created by the authenticated test client.",
      inputSchema: { receiptId: z.uuid() },
      annotations,
    },
    async ({ receiptId }) => {
      const receipt = store.get({ clientId, receiptId });
      if (!receipt) {
        onToolCall?.("dailynews_get_probe_receipt", "not_found");
        return failure("Probe receipt not found for this client.");
      }
      onToolCall?.("dailynews_get_probe_receipt", "success");
      return success("Probe receipt found.", receipt);
    },
  );

  return server;
}
