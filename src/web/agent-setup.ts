const mcpUrlPlaceholder = "{{MCP_URL}}";

function assertAbsoluteMcpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Agent setup MCP URL must be absolute");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("Agent setup MCP URL must be HTTP(S) without credentials, query, or fragment");
  }
}

export function renderAgentSetupMarkdown(source: string, mcpUrl: string): string {
  const occurrences = source.split(mcpUrlPlaceholder).length - 1;
  if (occurrences === 0) throw new Error(`Agent setup source is missing ${mcpUrlPlaceholder}`);
  assertAbsoluteMcpUrl(mcpUrl);
  const rendered = source.replaceAll(mcpUrlPlaceholder, mcpUrl);
  if (/\{\{[^{}]+\}\}/.test(rendered)) {
    throw new Error("Agent setup source contains an unresolved placeholder");
  }
  return rendered;
}
