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

function renderImage(image, options = {}) {
  if (!image) return "";
  const external = image.src.startsWith("https://");
  const credit = image.sourceUrl
    ? `<a href="${escapeHtml(image.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(image.credit)}</a>`
    : escapeHtml(image.credit);
  return `<figure class="story__media">
              <img class="story__image" src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" width="${image.width}" height="${image.height}" loading="${options.eager ? "eager" : "lazy"}" decoding="async"${options.eager ? ' fetchpriority="high"' : ""}${external ? ' referrerpolicy="no-referrer"' : ""}>
              <figcaption class="story__credit">${credit}</figcaption>
            </figure>`;
}

export function renderNoscriptFallback(issue) {
  if (!issue) {
    return `<section class="noscript-fallback" aria-labelledby="noscript-title">
      <p class="noscript-fallback__eyebrow">JavaScript 未启用</p>
      <h1 id="noscript-title">暂无日报</h1>
      <p>当前还没有可供展示的正式日报。</p>
    </section>`;
  }

  const modules = new Map(
    (issue.layout?.rows ?? []).flatMap(({ modules: rowModules }) => (
      rowModules.map((module) => [module.itemId, module])
    )),
  );
  const stories = issue.items.map((item, index) => {
    const source = item.sources[0];
    const module = modules.get(item.id);
    const media = module?.mediaVariant && module.mediaVariant !== "none"
      ? renderImage(item.image, { eager: index === 0 })
      : "";
    return `        <li class="noscript-fallback__item">
          <div>
            <h2>${escapeHtml(item.title)}</h2>
            ${media}
          </div>
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

function pageOptions(publications, options = {}) {
  const {
    currentId = null,
    homeSelected = false,
    todoEnabled = false,
    todoSelected = false,
  } = options;
  return [
    `            <option value="/"${homeSelected ? " selected" : ""}>总览</option>`,
    ...(todoEnabled
      ? [`            <option value="/todo/"${todoSelected ? " selected" : ""}>个人待办事项</option>`]
      : []),
    ...publications.map((publication) => (
      `            <option value="${escapeHtml(publication.pageUrl)}"${publication.id === currentId ? " selected" : ""}>${escapeHtml(publication.name)}</option>`
    )),
  ].join("\n");
}

function pageLinks(publications, options = {}) {
  const {
    currentId = null,
    homeSelected = false,
    todoEnabled = false,
    todoSelected = false,
  } = options;
  return [
    `<a href="/"${homeSelected ? ' aria-current="page"' : ""}>总览</a>`,
    ...(todoEnabled
      ? [`<a href="/todo/"${todoSelected ? ' aria-current="page"' : ""}>个人待办事项</a>`]
      : []),
    ...publications.map((publication) => (
      `<a href="${escapeHtml(publication.pageUrl)}"${publication.id === currentId ? ' aria-current="page"' : ""}>${escapeHtml(publication.name)}</a>`
    )),
  ].join("\n            ");
}

function todoDateLabel(item, asOfDate, context = "page") {
  if (!item.dueDate) return context === "home" ? "暂无日期" : "未设日期";
  const time = item.dueTime ? ` ${item.dueTime}` : "";
  if (item.dueDate < asOfDate) return `逾期 · ${item.dueDate}${time}`;
  if (item.dueDate === asOfDate) return `今天${time}`;
  return `${item.dueDate}${time}`;
}

function renderHomeTodo(todo) {
  const items = todo.homeItems;
  const body = items.length === 0
    ? `<p class="home-todo__empty">当前没有未完成事项。</p>
        <p class="home-todo__hint">你可以对 Agent 说：“明天下午三点前提交周报。”</p>`
    : `<ol class="home-todo__list">
${items.map((item) => `          <li>
            <a href="/todo/#${escapeHtml(item.id)}">${escapeHtml(item.title)}</a>
            <span class="home-todo__due">${escapeHtml(todoDateLabel(item, todo.asOfDate, "home"))}</span>
          </li>`).join("\n")}
        </ol>`;
  return `<section class="home-todo" data-module="todo" aria-labelledby="home-todo-title">
        <header class="home-todo__header">
          <div>
            <p class="home-todo__eyebrow">PRIVATE · LOCAL ONLY</p>
            <h2 id="home-todo-title"><a href="/todo/">个人待办事项</a></h2>
          </div>
          <a class="home-todo__all" href="/todo/">查看全部 →</a>
        </header>
        ${body}
      </section>`;
}

function withTodoStyles(html, enabled) {
  if (!enabled) return html;
  return html.replace("  </head>", '    <link rel="stylesheet" href="/todo.css">\n  </head>');
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
  const media = lead.image ? renderImage(lead.image, { eager: primary }) : "";
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
          <article class="home-highlight${media ? " home-highlight--media" : ""}">
            <div class="home-highlight__text">
              ${lead.category ? `<p class="story__category">${escapeHtml(lead.category)}</p>` : ""}
              <h3><a href="${escapeHtml(lead.itemUrl)}">${escapeHtml(lead.title)}</a></h3>
              <p>${escapeHtml(primary ? lead.summary : lead.brief)}</p>
            </div>
            ${media}
          </article>
          ${secondaryHtml}
        </section>`;
}

export function renderHomeHtml(template, {
  activeTheme,
  home,
  overview,
  publications,
  todo = null,
}) {
  const primary = overview.publications.find(({ id }) => id === overview.primaryPublicationId);
  const remaining = overview.publications.filter(({ id }) => id !== overview.primaryPublicationId);
  const content = `<main class="home-overview" id="content">
        <header class="home-overview__intro">
          <p>DAILY OVERVIEW · ${escapeHtml(overview.asOfDate)}</p>
          <h1>${escapeHtml(home.name)}</h1>
        </header>
        ${todo ? renderHomeTodo(todo) : ""}
        ${[primary, ...remaining].map((publication, index) => renderHomePublication(publication, index === 0)).join("\n")}
      </main>`;
  const html = themeHtml(template, activeTheme, home.name)
    .replace('<span class="brand__name">DailyNews</span>', `<span class="brand__name">${escapeHtml(home.name)}</span>`)
    .replace("            <!-- build:publication-options -->", pageOptions(publications, {
      homeSelected: true,
      todoEnabled: Boolean(todo),
    }))
    .replace("          <!-- build:home-directory -->", pageLinks(publications, {
      homeSelected: true,
      todoEnabled: Boolean(todo),
    }))
    .replace("      <!-- build:home-content -->", content);
  return withTodoStyles(html, Boolean(todo));
}

export function renderBuiltHtml(template, {
  activeTheme,
  issue,
  site,
  publicationId,
  publications,
  todoEnabled = false,
}) {
  const title = issue ? `${issue.date} · ${site.name}` : site.name;
  const visibleDate = issue ? issue.date.replaceAll("-", ".") : "—";
  const dateAttribute = issue ? ` datetime="${issue.date}"` : "";
  const pageUrl = `/p/${publicationId}/`;
  const publicationContext = safeJson({ publicationId, publications });

  const html = themeHtml(template, activeTheme, title)
    .replace('<span class="brand__name">DailyNews</span>', `<span class="brand__name">${escapeHtml(site.name)}</span>`)
    .replace('class="brand" href="/"', `class="brand" href="${pageUrl}"`)
    .replace("            <!-- build:publication-menu -->", pageLinks(publications, {
      currentId: publicationId,
      todoEnabled,
    }))
    .replace("            <!-- build:publication-options -->", pageOptions(publications, {
      currentId: publicationId,
      todoEnabled,
    }))
    .replace("<!-- build:publication-context -->", publicationContext)
    .replace(
      '<time class="date-nav__current" aria-live="polite">—</time>',
      `<time class="date-nav__current"${dateAttribute} aria-live="polite">${visibleDate}</time>`,
    )
    .replace("<!-- build:noscript -->", renderNoscriptFallback(issue));
  return withTodoStyles(html, todoEnabled);
}

function renderTodoTask(item, group, asOfDate) {
  const completed = group === "completedToday";
  const status = completed ? "已完成" : group === "overdue" ? "已逾期" : "未完成";
  const date = completed
    ? `完成于 ${new Date(item.completedAt).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })}`
    : todoDateLabel(item, asOfDate);
  return `          <li>
            <article class="todo-item${completed ? " todo-item--completed" : ""}" id="${escapeHtml(item.id)}" tabindex="-1">
              <div class="todo-item__body">
                <span class="todo-item__state">${status}</span>
                <div>
                  <h3>${escapeHtml(item.title)}</h3>
                  ${item.note ? `<p class="todo-item__note">${escapeHtml(item.note)}</p>` : ""}
                </div>
              </div>
              <time class="todo-item__date">${escapeHtml(date)}</time>
            </article>
          </li>`;
}

export function renderTodoHtml(template, {
  activeTheme,
  home,
  projection,
  publications,
}) {
  const definitions = [
    ["overdue", "已逾期", "PAST DUE"],
    ["today", "今天", "TODAY"],
    ["upcoming", "接下来", "UPCOMING"],
    ["undated", "暂无日期", "NO DATE"],
    ["completedToday", "今天已完成", "COMPLETED TODAY"],
  ];
  const groups = definitions.map(([key, label, eyebrow]) => {
    const items = projection.groups[key];
    const body = items.length > 0
      ? `<ol class="todo-group__list">
${items.map((item) => renderTodoTask(item, key, projection.asOfDate)).join("\n")}
        </ol>`
      : '<p class="todo-group__empty">这一组暂时没有事项。</p>';
    return `<section class="todo-group" aria-labelledby="todo-group-${key}">
        <header class="todo-group__header">
          <h2 id="todo-group-${key}">${label}</h2>
          <p class="todo-group__meta">${eyebrow}</p>
        </header>
        ${body}
      </section>`;
  }).join("\n");
  const content = `<main class="todo-page" id="content">
      <header class="todo-page__header">
        <p class="todo-page__eyebrow">PERSONAL TODO · ${escapeHtml(projection.asOfDate)}</p>
        <h1>个人待办事项</h1>
        <p class="todo-page__hint">这是本机上的只读清单。要新增、修改、完成或恢复事项，请直接告诉你的 Agent。</p>
      </header>
      <p class="todo-anchor-status" id="todo-anchor-status" role="status" tabindex="-1" hidden>未找到这条待办事项。</p>
      ${groups}
    </main>`;
  return themeHtml(template, activeTheme, "个人待办事项")
    .replace('<span class="brand__name">DailyNews</span>', `<span class="brand__name">${escapeHtml(home.name)}</span>`)
    .replace("            <!-- build:todo-menu -->", pageLinks(publications, {
      todoEnabled: true,
      todoSelected: true,
    }))
    .replace("            <!-- build:todo-options -->", pageOptions(publications, {
      todoEnabled: true,
      todoSelected: true,
    }))
    .replace("    <!-- build:todo-content -->", content);
}
