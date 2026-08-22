import { createMcpProbeHttpServer } from "./http.js";

function parseJsonEnvironment(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

function readConfiguration() {
  const activeTokenDigests = parseJsonEnvironment("MCP_PROBE_TOKEN_DIGESTS", {});
  const revokedTokenDigests = parseJsonEnvironment("MCP_PROBE_REVOKED_TOKEN_DIGESTS", []);
  const allowedOrigins = (process.env.MCP_PROBE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const port = Number(process.env.MCP_PROBE_PORT ?? "4317");

  if (
    !activeTokenDigests ||
    Array.isArray(activeTokenDigests) ||
    typeof activeTokenDigests !== "object" ||
    Object.keys(activeTokenDigests).length === 0
  ) {
    throw new Error("MCP_PROBE_TOKEN_DIGESTS must map client IDs to SHA-256 token digests.");
  }
  for (const [clientId, digest] of Object.entries(activeTokenDigests)) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(clientId) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("MCP_PROBE_TOKEN_DIGESTS contains an invalid client ID or digest.");
    }
  }
  if (!Array.isArray(revokedTokenDigests) || revokedTokenDigests.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("MCP_PROBE_REVOKED_TOKEN_DIGESTS must be a JSON array of SHA-256 digests.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP_PROBE_PORT must be an integer from 1 to 65535.");
  }

  return { activeTokenDigests, revokedTokenDigests, allowedOrigins, port };
}

try {
  const { port, ...options } = readConfiguration();
  const server = createMcpProbeHttpServer(options);
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`dailynews-mcp-probe listening on 127.0.0.1:${port}\n`);
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid probe configuration."}\n`);
  process.exitCode = 1;
}
