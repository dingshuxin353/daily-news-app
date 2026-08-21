import { relativeLuminance } from "./theme-validation.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function colorSchemeFor(background) {
  return relativeLuminance(background) < 0.36 ? "dark" : "light";
}

export function renderNoscriptFallback(issue) {
  if (!issue) {
    return `<section class="noscript-fallback" aria-labelledby="noscript-title">
      <p class="noscript-fallback__eyebrow">JavaScript 未启用</p>
      <h1 id="noscript-title">暂无日报</h1>
      <p>当前还没有可供展示的正式日报。</p>
    </section>`;
  }

  const stories = issue.items.map((item) => {
    const source = item.sources[0];
    return `        <li class="noscript-fallback__item">
          <h2>${escapeHtml(item.title)}</h2>
          <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)} ↗</a>
        </li>`;
  }).join("\n");

  return `<section class="noscript-fallback" aria-labelledby="noscript-title">
      <p class="noscript-fallback__eyebrow">JavaScript 未启用</p>
      <h1 id="noscript-title">${escapeHtml(issue.date)} 最新一期来源清单</h1>
      <p>这是构建时生成的最新一期只读来源清单，不解析地址栏中的日期参数。</p>
      <ol class="noscript-fallback__list">
${stories}
      </ol>
    </section>`;
}

export function renderBuiltHtml(template, { activeTheme, issue, site }) {
  const attributes = Object.entries(activeTheme.attributes)
    .map(([name, value]) => ` data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${escapeHtml(value)}"`)
    .join("");
  const colorScheme = colorSchemeFor(activeTheme.colors.background);
  const themeLink = `    <link id="active-theme" rel="stylesheet" href="${escapeHtml(activeTheme.cssPath)}">`;
  const title = issue ? `${issue.date} · ${site.name}` : site.name;
  const visibleDate = issue ? issue.date.replaceAll("-", ".") : "—";
  const dateAttribute = issue ? ` datetime="${issue.date}"` : "";

  return template
    .replace('<html lang="zh-CN">', `<html lang="zh-CN"${attributes} style="color-scheme: ${colorScheme}">`)
    .replace('<meta name="color-scheme" content="light">', `<meta name="color-scheme" content="${colorScheme}">`)
    .replace("<title>DailyNews</title>", `<title>${escapeHtml(title)}</title>`)
    .replace('    <link rel="stylesheet" href="/styles.css">', `    <link rel="stylesheet" href="/styles.css">\n${themeLink}`)
    .replace('<span class="brand__name">DailyNews</span>', `<span class="brand__name">${escapeHtml(site.name)}</span>`)
    .replace(
      '<time class="date-nav__current" aria-live="polite">—</time>',
      `<time class="date-nav__current"${dateAttribute} aria-live="polite">${visibleDate}</time>`,
    )
    .replace("<!-- build:noscript -->", renderNoscriptFallback(issue));
}
