# DailyNews MCP compatibility probe

This directory contains the disposable M0 compatibility probe retained after
the one-time validation. It is independent from the DailyNews content,
compiler, theme, and page pipelines. The redacted outcome and evidence are in
[`mcp-validation-report.md`](./mcp-validation-report.md).

The validation endpoint has been removed and the deployed probe is stopped.
Retaining this code does not mean WorkBuddy, Hermes, or scheduled execution was
validated.

## Fixed baseline

- MCP protocol: `2025-11-25`
- TypeScript SDK: `@modelcontextprotocol/sdk@1.30.0`
- MCP Inspector: `@modelcontextprotocol/inspector@2.3.0`
- Transport: stateless Streamable HTTP with JSON responses
- Endpoint: `/mcp-test`
- Bind address: `127.0.0.1`

Run the automated phase A checks with:

```bash
npm ci
npm run mcp-probe:test
```

## Configuration

The process accepts only token digests. Keep the environment file outside the
repository and make it readable only by the service account.

```dotenv
MCP_PROBE_PORT=4317
MCP_PROBE_TOKEN_DIGESTS={"codex":"<64-lowercase-hex>","workbuddy":"<64-lowercase-hex>","hermes":"<64-lowercase-hex>"}
MCP_PROBE_REVOKED_TOKEN_DIGESTS=[]
MCP_PROBE_ALLOWED_ORIGINS=https://allowed-inspector-origin.example
```

Each client receives a separate random token of at least 256 bits. The raw
tokens must not be placed in this repository, server environment, URLs, logs,
screenshots, or reports. Start the probe with an external environment file:

```bash
node --env-file=/absolute/path/outside-the-repository/probe.env test-support/mcp-probe/server.js
```

The service fails closed when the digest map is missing or malformed.

## Deployment gate

Do not deploy until SSH key access is verified, the previously exposed root
password is rotated, separate temporary client tokens exist, and the current
Nginx site configuration is backed up. The probe must continue to listen only
on `127.0.0.1`; do not open port `4317` publicly.

Add only an exact Nginx route to the existing HTTPS server:

```nginx
location = /mcp-test {
    client_max_body_size 256k;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header MCP-Protocol-Version $http_mcp_protocol_version;
    proxy_pass http://127.0.0.1:4317/mcp-test;
    proxy_buffering off;
    proxy_read_timeout 60s;
}
```

Validate Nginx syntax before reloading it. Confirm that no other route or public
port changed. Run the pinned Inspector with `npm run mcp-probe:inspect`, connect
to the public HTTPS endpoint, and use a dedicated temporary Inspector token.

## Rollback

1. Revoke every temporary client and Inspector token.
2. Stop the probe process; its in-memory receipts disappear on exit.
3. Restore the backed-up Nginx site configuration and validate it before reload.
4. Confirm `/mcp-test` is unavailable and the existing site still behaves normally.
5. Keep only redacted evidence outside this directory; remove raw client configuration and screenshots that cannot be safely redacted.
