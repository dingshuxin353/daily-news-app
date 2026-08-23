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

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function themeHtml(template, activeTheme, title) {
  const attributes = Object.entries(activeTheme.attributes)
    .map(([name, value]) => ` data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${escapeHtml(value)}"`)
    .join("");
  const colorScheme = colorSchemeFor(activeTheme.colors.background);
  const themeLink = `    <link id="active-theme" rel="stylesheet" href="${escapeHtml(activeTheme.cssPath)}">`;
  return template
    .replace('<html lang="zh-CN">', `<html lang="zh-CN"${attributes} style="color-scheme: ${colorScheme}">`)
    .replace('<meta name="color-scheme" content="light">', `<meta name="color-scheme" content="${colorScheme}">`)
    .replace("<title>DailyNews</title>", `<title>${escapeHtml(title)}</title>`)
    .replace('    <link rel="stylesheet" href="/styles.css">', `    <link rel="stylesheet" href="/styles.css">\n${themeLink}`);
}

function pageOptions(publications, currentId = null, homeSelected = false) {
  return [
    `            <option value="/"${homeSelected ? " selected" : ""}>总览</option>`,
    ...publications.map((publication) => (
      `            <option value="${escapeHtml(publication.pageUrl)}"${publication.id === currentId ? " selected" : ""}>${escapeHtml(publication.name)}</option>`
    )),
  ].join("\n");
}

function pageLinks(publications, currentId = null, homeSelected = false) {
  return [
    `<a href="/"${homeSelected ? ' aria-current="page"' : ""}>总览</a>`,
    ...publications.map((publication) => (
      `<a href="${escapeHtml(publication.pageUrl)}"${publication.id === currentId ? ' aria-current="page"' : ""}>${escapeHtml(publication.name)}</a>`
    )),
  ].join("\n            ");
}

function statusLabel(publication) {
  if (publication.status === "current") return "今日更新";
  if (publication.status === "empty") return "暂无日报";
  return `最近更新 ${publication.latestDate}`;
}

function renderHomePublication(publication, primary = false) {
  if (publication.status === "empty") {
    return `<section class="home-publication${primary ? " home-publication--primary" : ""}" aria-labelledby="home-${escapeHtml(publication.id)}">
          <header class="home-publication__header">
            <div>
              <p class="home-publication__status">${statusLabel(publication)}</p>
              <h2 id="home-${escapeHtml(publication.id)}">${escapeHtml(publication.name)}</h2>
            </div>
            <a href="${escapeHtml(publication.pageUrl)}">进入日报 →</a>
          </header>
          <p class="home-publication__empty">这份日报还没有正式发布内容。</p>
        </section>`;
  }
  const [lead, ...secondary] = publication.highlights;
  const secondaryHtml = secondary.length === 0 ? "" : `<ol class="home-highlights__secondary">
${secondary.map((item) => `            <li><a href="${escapeHtml(item.itemUrl)}">${escapeHtml(item.title)}</a></li>`).join("\n")}
          </ol>`;
  return `<section class="home-publication${primary ? " home-publication--primary" : ""}" aria-labelledby="home-${escapeHtml(publication.id)}">
          <header class="home-publication__header">
            <div>
              <p class="home-publication__status">${statusLabel(publication)}</p>
              <h2 id="home-${escapeHtml(publication.id)}">${escapeHtml(publication.name)}</h2>
            </div>
            <a href="${escapeHtml(publication.pageUrl)}">完整日报 →</a>
          </header>
          <article class="home-highlight">
            ${lead.category ? `<p class="story__category">${escapeHtml(lead.category)}</p>` : ""}
            <h3><a href="${escapeHtml(lead.itemUrl)}">${escapeHtml(lead.title)}</a></h3>
            <p>${escapeHtml(primary ? lead.summary : lead.brief)}</p>
          </article>
          ${secondaryHtml}
        </section>`;
}

export function renderHomeHtml(template, { activeTheme, home, overview, publications }) {
  const primary = overview.publications.find(({ id }) => id === overview.primaryPublicationId);
  const remaining = overview.publications.filter(({ id }) => id !== overview.primaryPublicationId);
  const content = `<main class="home-overview" id="content">
        <header class="home-overview__intro">
          <p>DAILY OVERVIEW · ${escapeHtml(overview.asOfDate)}</p>
          <h1>${escapeHtml(home.name)}</h1>
        </header>
        ${[primary, ...remaining].map((publication, index) => renderHomePublication(publication, index === 0)).join("\n")}
      </main>`;
  return themeHtml(template, activeTheme, home.name)
    .replace('<span class="brand__name">DailyNews</span>', `<span class="brand__name">${escapeHtml(home.name)}</span>`)
    .replace("            <!-- build:publication-options -->", pageOptions(publications, null, true))
    .replace("          <!-- build:home-directory -->", pageLinks(publications, null, true))
    .replace("      <!-- build:home-content -->", content);
}

export function renderBuiltHtml(template, {
  activeTheme,
  issue,
  site,
  publicationId,
  publications,
}) {
  const title = issue ? `${issue.date} · ${site.name}` : site.name;
  const visibleDate = issue ? issue.date.replaceAll("-", ".") : "—";
  const dateAttribute = issue ? ` datetime="${issue.date}"` : "";
  const pageUrl = `/p/${publicationId}/`;
  const publicationContext = safeJson({ publicationId, publications });

  return themeHtml(template, activeTheme, title)
    .replace('<span class="brand__name">DailyNews</span>', `<span class="brand__name">${escapeHtml(site.name)}</span>`)
    .replace('class="brand" href="/"', `class="brand" href="${pageUrl}"`)
    .replace("            <!-- build:publication-menu -->", pageLinks(publications, publicationId))
    .replace("            <!-- build:publication-options -->", pageOptions(publications, publicationId))
    .replace("<!-- build:publication-context -->", publicationContext)
    .replace(
      '<time class="date-nav__current" aria-live="polite">—</time>',
      `<time class="date-nav__current"${dateAttribute} aria-live="polite">${visibleDate}</time>`,
    )
    .replace("<!-- build:noscript -->", renderNoscriptFallback(issue));
}
