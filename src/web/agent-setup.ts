const apiBaseUrlPlaceholder = "{{API_BASE_URL}}";

function assertAbsoluteApiBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Agent setup API Base URL must be absolute");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("Agent setup API Base URL must be HTTP(S) without credentials, query, or fragment");
  }
}

export function renderAgentSetupMarkdown(source: string, apiBaseUrl: string): string {
  const occurrences = source.split(apiBaseUrlPlaceholder).length - 1;
  if (occurrences === 0) throw new Error(`Agent setup source is missing ${apiBaseUrlPlaceholder}`);
  assertAbsoluteApiBaseUrl(apiBaseUrl);
  const rendered = source.replaceAll(apiBaseUrlPlaceholder, apiBaseUrl);
  if (/\{\{[^{}]+\}\}/.test(rendered)) {
    throw new Error("Agent setup source contains an unresolved placeholder");
  }
  return rendered;
}
