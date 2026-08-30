const endpointPlaceholders = {
  claimUrl: "{{CLAIM_URL}}",
  verifyUrl: "{{VERIFY_URL}}",
  apiBaseUrl: "{{API_BASE_URL}}",
  mcpUrl: "{{MCP_URL}}",
} as const;

export interface AgentSetupEndpoints {
  claimUrl: string;
  verifyUrl: string;
  apiBaseUrl: string;
  mcpUrl: string;
}

function assertAbsoluteEndpoint(name: keyof AgentSetupEndpoints, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Agent setup ${name} must be an absolute URL`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`Agent setup ${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
}

export function renderAgentSetupMarkdown(source: string, endpoints: AgentSetupEndpoints): string {
  let rendered = source;
  for (const [name, placeholder] of Object.entries(endpointPlaceholders) as Array<
    [keyof AgentSetupEndpoints, string]
  >) {
    if (!rendered.includes(placeholder)) {
      throw new Error(`Agent setup source is missing ${placeholder}`);
    }
    const value = endpoints[name];
    assertAbsoluteEndpoint(name, value);
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/\{\{[^{}]+\}\}/.test(rendered)) {
    throw new Error("Agent setup source contains an unresolved placeholder");
  }
  return rendered;
}
