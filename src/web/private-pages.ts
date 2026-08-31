import { compileIssue } from "../../scripts/lib/compiler.js";
import { buildDailyReadingProjection } from "../../scripts/lib/domain/daily-reading.js";
import type {
  DailyReading,
  PublicationReadingSummary,
  ReadingShell,
} from "../modules/private-reading/service.js";
import type { CredentialRecord } from "../modules/agent-access/credential-service.js";
import type { UserProfile } from "../modules/identity/profile-service.js";

type PageName = "public" | "login" | "onboarding" | "home" | "publications" | "daily" | "todo" | "settings" | "agent-settings";

interface PageShellOptions {
  basePath: string;
  title: string;
  page: PageName;
  body: string;
  privatePage?: boolean;
  nav?: { todoVisible: boolean; current: string; themeId: string; themeRevision: number; colorScheme: "light" | "dark"; nickname?: string | null };
  returnTo?: string;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function path(basePath: string, pathname: string): string {
  return `${basePath}${pathname}`;
}

function navigation(basePath: string, nav: NonNullable<PageShellOptions["nav"]>): string {
  const links = [
    { key: "home", href: path(basePath, "/home"), label: "总览" },
    { key: "publications", href: path(basePath, "/publications/"), label: "我的日报" },
    ...(nav.todoVisible ? [{ key: "todo", href: path(basePath, "/todo/"), label: "Todo" }] : []),
    { key: "settings", href: path(basePath, "/settings"), label: "编辑部设置" },
  ];
  const account = nav.nickname
    ? `<a class="product-account" href="${escapeHtml(path(basePath, "/settings/account"))}" aria-label="账户：${escapeHtml(nav.nickname)}"><span aria-hidden="true">${escapeHtml([...nav.nickname][0] ?? "你")}</span><strong>${escapeHtml(nav.nickname)}</strong></a>`
    : "";
  return `<div class="product-navigation"><nav class="product-nav" aria-label="私人空间">
        ${links.map((link) => `<a href="${escapeHtml(link.href)}"${nav.current === link.key ? ' aria-current="page"' : ""}>${escapeHtml(link.label)}</a>`).join("\n        ")}
      </nav>${account}</div>
      <label class="product-nav-select">
        <span>前往</span>
        <select data-page-select>
          ${links.map((link) => `<option value="${escapeHtml(link.href)}"${nav.current === link.key ? " selected" : ""}>${escapeHtml(link.label)}</option>`).join("\n          ")}
        </select>
      </label>`;
}

function shell(options: PageShellOptions): string {
  const basePath = escapeHtml(options.basePath);
  const colorScheme = options.nav?.colorScheme ?? "light";
  const themeStylesheet = options.privatePage && options.nav
    ? `<link rel="stylesheet" href="${basePath}/assets/themes/${encodeURIComponent(options.nav.themeId)}/${options.nav.themeRevision}.css">`
    : "";
  const masthead = options.privatePage
    ? `<header class="cloud-masthead cloud-masthead--product">
      <p class="cloud-masthead__line">你的私人编辑部</p>
      <a class="cloud-masthead__name" href="${basePath}/home">DailyNews</a>
      ${options.nav ? navigation(options.basePath, options.nav) : ""}
      <hr class="cloud-masthead__rule" aria-hidden="true">
    </header>`
    : `<header class="cloud-masthead">
      <p class="cloud-masthead__line">每天一份 · 私人编写</p>
      <a class="cloud-masthead__name" href="${basePath}/">DailyNews</a>
      <hr class="cloud-masthead__rule" aria-hidden="true">
    </header>`;
  return `<!doctype html>
<html lang="zh-CN" data-color-scheme="${colorScheme}">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="${colorScheme}">
    <link rel="icon" href="data:,">
    <title>${escapeHtml(options.title)} · DailyNews</title>
    <link rel="stylesheet" href="${basePath}/assets/cloud.css">
    ${themeStylesheet}
  </head>
  <body data-base-path="${basePath}" data-page="${options.page}"${options.returnTo ? ` data-return-to="${escapeHtml(options.returnTo)}"` : ""}>
    <a class="skip-link" href="#content">跳到正文</a>
    ${masthead}
    ${options.body}
    <footer class="cloud-footer"><p>DailyNews · 内容属于你，控制权也属于你。</p></footer>
    <script type="module" src="${basePath}/assets/cloud-auth.js"></script>
    <script type="module" src="${basePath}/assets/private-pages.js"></script>
  </body>
</html>`;
}

export function renderPublicPage(input: { basePath: string; signedIn: boolean }): string {
  const action = input.signedIn
    ? `<a class="button" href="${escapeHtml(path(input.basePath, "/home"))}">进入私人日报</a>`
    : `<a class="button" href="${escapeHtml(path(input.basePath, "/login"))}">登录 / 注册</a>`;
  return shell({
    basePath: input.basePath,
    title: "你的私人日报",
    page: "public",
    body: `<main class="public-main" id="content">
      <section class="public-hero" aria-labelledby="public-title">
        <div class="public-hero__copy">
          <h1 id="public-title">每天一份，只为你而编的私人日报。</h1>
          <p class="public-hero__summary">把每天关心的事，交给你的私人编辑部。</p>
          ${action}
        </div>
        <figure class="public-hero__figure">
          <img src="${escapeHtml(path(input.basePath, "/assets/private-newsroom.png"))}" alt="几位 Agent 在编辑桌前协作整理私人日报" width="1400" height="466" fetchpriority="high">
          <figcaption>一个 Agent 可以独立工作，多个 Agent 也可以组成团队；最后的授权始终由你掌握。</figcaption>
        </figure>
      </section>
      <section class="public-principles" aria-label="产品原则">
        <p>你只需要说清关心什么，以及希望什么时候看到更新。</p>
        <p>DailyNews 保存正式日报和待办，不接管 Agent 所在环境里的定时任务。</p>
        <p>每个 Agent 使用独立授权，可以单独添加或移除。</p>
      </section>
    </main>`,
  });
}

export function renderLoginPage(basePath: string, input: { returnTo?: string; returnLabel?: string } = {}): string {
  return shell({
    basePath,
    title: "邮箱登录",
    page: "login",
    returnTo: input.returnTo,
    body: `<main class="cloud-main" id="content">
      <section class="cloud-intro" aria-labelledby="login-title">
        <p class="cloud-intro__kicker">私人空间</p>
        <h1 id="login-title">邮箱登录</h1>
        <p class="cloud-intro__summary">无需密码。输入邮箱并使用 6 位验证码，新邮箱会自动建立自己的私人空间。</p>
        ${input.returnLabel ? `<p class="return-note">登录后返回：${escapeHtml(input.returnLabel)}</p>` : ""}
      </section>
      <section class="auth-workbench" aria-label="登录步骤">
        <form class="auth-form" data-email-form data-state="idle" novalidate>
          <div class="auth-form__field">
            <label class="auth-form__label" for="email">邮箱地址</label>
            <input class="auth-form__input" id="email" name="email" type="email" autocomplete="email" inputmode="email" aria-describedby="email-helper" aria-required="true" required>
            <p class="auth-form__helper" id="email-helper" data-helper aria-live="polite">验证码有效期为 5 分钟。</p>
          </div>
          <button class="button" type="submit">发送验证码</button>
        </form>
        <form class="auth-form" data-otp-form data-state="idle" novalidate hidden>
          <input name="email" type="hidden">
          <div class="auth-form__field">
            <label class="auth-form__label" for="otp">6 位验证码</label>
            <input class="auth-form__input" id="otp" name="otp" type="text" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" aria-describedby="otp-helper" aria-required="true" required>
            <p class="auth-form__helper" id="otp-helper" data-helper aria-live="polite">输入邮件中的验证码。</p>
          </div>
          <button class="button" type="submit">验证并进入</button>
        </form>
        <p class="privacy-note">验证码只用于本次登录；DailyNews 不提供密码登录，也不会在浏览器持久保存邮箱。</p>
      </section>
    </main>`,
  });
}

const sampleIssue = {
  schemaVersion: 1,
  date: "2026-01-01",
  generatedAt: "2026-01-01T08:00:00+08:00",
  coverage: { start: "2025-12-31T08:00:00+08:00", end: "2026-01-01T08:00:00+08:00" },
  revision: 1,
  items: [
    {
      id: "sample-focus",
      title: "把一天的信息，先整理成一条清晰主线",
      brief: "私人日报先给出最重要的判断，再保留继续阅读的来源入口。",
      summary: "这是一份不依赖实时事实的系统示例。正式使用后，你的 Agent 会根据长期关注方向整理内容，DailyNews 再把经过校验的正式结果稳定呈现在同一个阅读位置。",
      category: "阅读方式",
      editorial: { priority: "lead", selectionReason: "展示正式日报的主次层级" },
      sources: [{ name: "DailyNews 使用说明", url: "https://github.com/dingshuxin353/daily-news-app" }],
    },
    {
      id: "sample-control",
      title: "每个 Agent 都有独立授权",
      brief: "新增或移除某个 Agent，不会覆盖其他连接。",
      summary: "DailyNews 只显示服务端能够确认的授权事实，不会把客户端在线状态或本地定时任务猜成产品状态。你可以在编辑部设置中单独管理每一条连接。",
      category: "安全",
      editorial: { priority: "important", selectionReason: "解释用户控制边界" },
      sources: [{ name: "DailyNews Agent 指南", url: "https://github.com/dingshuxin353/daily-news-app" }],
    },
    {
      id: "sample-todo",
      title: "Todo 只在需要时开启",
      brief: "启用后 Agent 才能写入个人待办，关闭时保留已有内容。",
      summary: "Personal Todo 属于整个私人空间。它默认关闭，不会为了展示功能而制造虚假任务；启用后页面只读取正式 Todo State，并沿用固定的五组排序。",
      category: "个人待办",
      editorial: { priority: "normal", selectionReason: "说明按需启用原则" },
      sources: [{ name: "DailyNews Todo 指南", url: "https://github.com/dingshuxin353/daily-news-app" }],
    },
  ],
};
const sampleCompiled = compileIssue(sampleIssue).compiled;
const sampleProjection: any = buildDailyReadingProjection(sampleCompiled, sampleIssue);

function pageNav(shellInput: ReadingShell, current: string) {
  return {
    todoVisible: shellInput.todoEnabled && shellInput.todoHasFormalData,
    current,
    themeId: shellInput.theme.id,
    themeRevision: shellInput.theme.revision,
    colorScheme: shellInput.theme.colorScheme,
    nickname: shellInput.nickname,
  };
}

export type SettingsSection = "sites" | "themes" | "agent" | "account" | "advanced";

function settingsNavigation(basePath: string, current: SettingsSection): string {
  const links: Array<{ key: SettingsSection; href: string; label: string }> = [
    { key: "sites", href: "/settings/sites", label: "日报站点" },
    { key: "themes", href: "/settings/themes", label: "主题库" },
    { key: "agent", href: "/settings/agent", label: "Agent 授权" },
    { key: "account", href: "/settings/account", label: "账户与安全" },
    { key: "advanced", href: "/settings/advanced", label: "高级接入" },
  ];
  return `<nav class="settings-index" aria-label="设置分类">
    ${links.map((link, index) => `<a href="${escapeHtml(path(basePath, link.href))}"${current === link.key ? ' aria-current="page"' : ""}><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(link.label)}</a>`).join("")}
  </nav>`;
}

export function renderSettingsDocument(input: {
  basePath: string;
  shell: ReadingShell;
  current: SettingsSection;
  title: string;
  kicker: string;
  summary: string;
  content: string;
}): string {
  return shell({
    basePath: input.basePath,
    title: input.title,
    page: input.current === "agent" || input.current === "advanced" ? "agent-settings" : "settings",
    privatePage: true,
    nav: pageNav(input.shell, "settings"),
    body: `<main class="settings-main settings-main--indexed" id="content">
      <header class="settings-heading"><p>${escapeHtml(input.kicker)}</p><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.summary)}</p></header>
      ${settingsNavigation(input.basePath, input.current)}
      <div class="settings-workspace">${input.content}</div>
    </main>`,
  });
}

function sourceEntry(source: Record<string, any>, index: number): string {
  const via = source.via && typeof source.via === "object"
    ? `<p>经由 <a href="${escapeHtml(source.via.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.via.name)}</a></p>`
    : "";
  return `<li><p class="source-role">${index === 0 ? "主要来源" : "补充来源"}</p><h3>${escapeHtml(source.name)}</h3>${source.originalTitle ? `<p>${escapeHtml(source.originalTitle)}</p>` : ""}${source.publishedAt ? `<time datetime="${escapeHtml(source.publishedAt)}">${escapeHtml(source.publishedAt)}</time>` : ""}<a class="text-link" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">打开原文 ↗</a>${via}</li>`;
}

function sourceArchive(item: Record<string, any>): string {
  return `<section class="source-set" id="sources-${escapeHtml(item.id)}" data-source-title="${escapeHtml(item.title)}" tabindex="-1"><h2>${escapeHtml(item.title)}</h2><ol>${item.sources.map(sourceEntry).join("")}</ol></section>`;
}

function itemMedia(item: Record<string, any>, eager: boolean): string {
  if (!item.image || typeof item.image !== "object") return "";
  const source = item.image.sourceUrl
    ? `<a href="${escapeHtml(item.image.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.image.credit)}</a>`
    : escapeHtml(item.image.credit);
  return `<figure class="daily-module__media"><img src="${escapeHtml(item.image.src)}" alt="${escapeHtml(item.image.alt)}" width="${Number(item.image.width)}" height="${Number(item.image.height)}" decoding="async" loading="${eager ? "eager" : "lazy"}"${eager ? ' fetchpriority="high"' : ""}${String(item.image.src).startsWith("https://") ? ' referrerpolicy="no-referrer"' : ""} data-reading-image><figcaption>${source}</figcaption><p class="image-fallback" data-image-fallback hidden>配图暂不可用，不影响正文阅读。</p></figure>`;
}

function dailyModule(module: Record<string, any>, index: number): string {
  const item = module.item;
  const sources = Array.isArray(item.sources) ? item.sources : [];
  const source = sources[0];
  const copy = module.size === "large" ? item.summary : item.brief;
  const sourceAction = sources.length > 1
    ? `<button class="source-trigger" type="button" data-source-open="sources-${escapeHtml(item.id)}" hidden>查看全部 ${sources.length} 个来源</button><noscript><a href="#sources-${escapeHtml(item.id)}">查看全部 ${sources.length} 个来源</a></noscript>`
    : source ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)} ↗</a>` : "";
  return `<article class="daily-module daily-module--${escapeHtml(module.size)} daily-module--span-${Number(module.span)}" id="${escapeHtml(item.id)}">
      <header><span>${escapeHtml(item.category ?? "今日编辑")}</span><span>${String(index + 1).padStart(2, "0")}</span></header>
      <h2>${escapeHtml(item.title)}</h2>
      ${itemMedia(item, index === 0)}
      <p>${escapeHtml(copy)}</p>
      <footer class="daily-module__sources">${sourceAction}</footer>
    </article>`;
}

function dailyEdition(projection: any): { content: string; sources: string } {
  let index = 0;
  const modules = projection.rows.flatMap((row: any) => row.modules);
  const content = projection.rows.map((row: any) => `<div class="daily-row">
    ${row.modules.map((module: any) => dailyModule(module, index++)).join("\n    ")}
  </div>`).join("\n");
  const multipleSources = modules
    .map(({ item }: any) => item)
    .filter((item: any) => Array.isArray(item.sources) && item.sources.length > 1);
  return {
    content,
    sources: multipleSources.length === 0 ? "" : `<aside class="source-archive" aria-labelledby="source-archive-title"><h2 id="source-archive-title">全部来源</h2>${multipleSources.map(sourceArchive).join("")}</aside><dialog class="source-dialog" data-source-dialog aria-labelledby="source-dialog-title"><header><div><p>来源清单</p><h2 id="source-dialog-title" data-source-dialog-title>全部来源</h2></div><button class="source-dialog__close" type="button" data-source-close>关闭 ×</button></header><div data-source-dialog-content></div></dialog>`,
  };
}

function publicationSummary(basePath: string, summary: PublicationReadingSummary, primary = false): string {
  const href = path(basePath, `/p/${encodeURIComponent(summary.publication.publicationId)}/${summary.latest ? `?date=${summary.latest.date}` : ""}`);
  return `<li class="publication-entry${primary ? " publication-entry--primary" : ""}"><div><p>${primary ? "首要日报" : "日报"}</p><h2>${escapeHtml(summary.publication.displayName)}</h2>${summary.latest ? `<time datetime="${escapeHtml(summary.latest.date)}">${escapeHtml(summary.latest.date)}</time><p>${escapeHtml(summary.latest.title)}</p>` : "<p>第一份正式日报还没有到达。</p>"}</div><a class="text-link" href="${escapeHtml(href)}">${summary.latest ? "打开最新一期" : "打开日报"} →</a></li>`;
}

export function renderHomePage(input: {
  basePath: string;
  shell: ReadingShell;
  daily: DailyReading | null;
  publications?: PublicationReadingSummary[];
  todoProjection?: any;
}): string {
  const formal = input.daily;
  const projection = formal?.projection ?? sampleProjection;
  const lead = projection.rows[0]?.modules[0]?.item;
  const href = formal
    ? path(input.basePath, `/p/${encodeURIComponent(input.shell.publication.publicationId)}/?date=${formal.date}`)
    : path(input.basePath, "/onboarding");
  const todoItems = input.todoProjection?.homeItems ?? [];
  return shell({
    basePath: input.basePath,
    title: input.shell.spaceName,
    page: "home",
    privatePage: true,
    nav: pageNav(input.shell, "home"),
    body: `<main class="reading-main" id="content" data-theme-id="${escapeHtml(input.shell.theme.id)}" data-theme-revision="${input.shell.theme.revision}">
      <section class="home-edition" aria-labelledby="home-title">
        <header class="home-edition__header">
          <div><p>${formal ? escapeHtml(formal.date) : "系统内置 · 不代表今日"}</p><h1 id="home-title">${formal ? escapeHtml(input.shell.publication.displayName) : "示例日报"}</h1></div>
          <span class="paper-label">${formal ? "个性化正式日报" : "示例日报"}</span>
        </header>
        <article class="home-lead">
          <p>${escapeHtml(lead?.category ?? "阅读方式")}</p>
          <h2>${escapeHtml(lead?.title ?? "日报尚未准备好")}</h2>
          <p>${escapeHtml(lead?.summary ?? lead?.brief ?? "连接 Agent 后，这里会显示第一份个性化正式日报。")}</p>
          <a class="text-link" href="${escapeHtml(href)}">${formal ? "阅读完整日报" : "设置自动日报"} →</a>
        </article>
      </section>
      ${(input.publications ?? []).length ? `<section class="home-publications" aria-labelledby="home-publications-title"><header><p>其他日报</p><h2 id="home-publications-title">继续阅读</h2></header><ol>${input.publications!.map((publication) => publicationSummary(input.basePath, publication)).join("")}</ol><a class="text-link" href="${escapeHtml(path(input.basePath, "/publications/"))}">查看我的日报 →</a></section>` : ""}
      ${todoItems.length > 0 ? `<section class="home-todo" aria-labelledby="home-todo-title">
        <header><h2 id="home-todo-title">个人待办</h2><a href="${escapeHtml(path(input.basePath, "/todo/"))}">查看全部 →</a></header>
        <ol>${todoItems.map((item: any) => `<li><a href="${escapeHtml(path(input.basePath, `/todo/#${item.id}`))}">${escapeHtml(item.title)}</a><span>${escapeHtml(item.dueDate ?? "暂无日期")}</span></li>`).join("")}</ol>
      </section>` : ""}
      ${!formal ? `<a class="secondary-journey" href="${escapeHtml(path(input.basePath, "/onboarding"))}">把自动日报真正用起来</a>` : ""}
    </main>`,
  });
}

export function renderPublicationsPage(input: { basePath: string; shell: ReadingShell; publications: PublicationReadingSummary[] }): string {
  return shell({
    basePath: input.basePath,
    title: "我的日报",
    page: "publications",
    privatePage: true,
    nav: pageNav(input.shell, "publications"),
    body: `<main class="publication-directory" id="content" data-theme-id="${escapeHtml(input.shell.theme.id)}" data-theme-revision="${input.shell.theme.revision}"><header class="directory-heading"><p>私人阅读目录</p><h1>我的日报</h1><p>这里只列出正在使用的日报。创建、排序或停用请前往编辑部设置。</p></header><ol>${input.publications.map((publication) => publicationSummary(input.basePath, publication, publication.publication.isDefault)).join("")}</ol></main>`,
  });
}

function dateNavigation(basePath: string, publicationId: string, currentDate: string, dates: string[]): string {
  const index = dates.indexOf(currentDate);
  const newer = index > 0 ? dates[index - 1] : null;
  const older = index >= 0 && index < dates.length - 1 ? dates[index + 1] : null;
  const href = (date: string) => path(basePath, `/p/${encodeURIComponent(publicationId)}/?date=${date}`);
  return `<nav class="edition-navigation" aria-label="正式日报期次"><span>${newer ? `<a href="${escapeHtml(href(newer))}">← 更新一期</a>` : "已经是最新一期"}</span><time datetime="${escapeHtml(currentDate)}">${escapeHtml(currentDate)}</time><span>${older ? `<a href="${escapeHtml(href(older))}">更早一期 →</a>` : "已经是最早一期"}</span></nav>`;
}

export function renderDailyPage(input: { basePath: string; shell: ReadingShell; daily: DailyReading | null; dates?: string[]; requestedDate?: string }): string {
  const dates = input.dates ?? input.daily?.dates ?? [];
  const edition = input.daily ? dailyEdition(input.daily.projection) : null;
  const latest = dates[0];
  const body = input.daily && edition
    ? `<main class="daily-main" id="content" data-theme-id="${escapeHtml(input.shell.theme.id)}" data-theme-revision="${input.shell.theme.revision}">
      <header class="daily-heading"><div><p>${input.shell.publication.status === "inactive" ? "已停用 · 只读归档" : "正式日报"}</p><h1>${escapeHtml(input.shell.publication.displayName)}</h1></div><span>${input.daily.projection.rows.flatMap(({ modules }) => modules).length} 则内容</span></header>
      ${dateNavigation(input.basePath, input.shell.publication.publicationId, input.daily.date, dates)}
      <section class="daily-edition" aria-label="${escapeHtml(input.daily.date)} 日报内容">${edition.content}</section>${edition.sources}
    </main>`
    : `<main class="empty-reading" id="content"><p>${input.shell.publication.status === "inactive" ? "已停用 · 只读归档" : "日报"}</p><h1>${input.requestedDate ? "这一天没有正式日报" : "第一份正式日报还没有到达"}</h1><p>${input.requestedDate ? `日期 ${escapeHtml(input.requestedDate)} 没有正式内容，DailyNews 没有替你回退到其他日期。` : "这份日报会在第一份正式内容到达后出现在阅读目录中。"}</p>${latest ? `<a class="button button--quiet" href="${escapeHtml(path(input.basePath, `/p/${encodeURIComponent(input.shell.publication.publicationId)}/?date=${latest}`))}">阅读最近一期 · ${escapeHtml(latest)}</a>` : `<a class="button button--quiet" href="${escapeHtml(path(input.basePath, "/publications/"))}">返回我的日报</a>`}</main>`;
  const title = input.daily ? `${input.shell.publication.displayName} · ${input.daily.date}` : input.shell.publication.displayName;
  return shell({ basePath: input.basePath, title, page: "daily", privatePage: true, nav: pageNav(input.shell, "publications"), body });
}

function todoDate(item: any, asOfDate: string, completed: boolean, timeZone: string): string {
  if (completed && item.completedAt) return `完成于 ${new Date(item.completedAt).toLocaleTimeString("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false })}`;
  if (!item.dueDate) return "未设日期";
  const time = item.dueTime ? ` ${item.dueTime}` : "";
  if (item.dueDate < asOfDate) return `逾期 · ${item.dueDate}${time}`;
  if (item.dueDate === asOfDate) return `今天${time}`;
  return `${item.dueDate}${time}`;
}

export function renderTodoPage(input: { basePath: string; shell: ReadingShell; projection: any }): string {
  const definitions = [
    ["overdue", "已逾期"], ["today", "今天"], ["upcoming", "接下来"], ["undated", "暂无日期"], ["completedToday", "今天已完成"],
  ];
  return shell({
    basePath: input.basePath,
    title: "个人待办",
    page: "todo",
    privatePage: true,
    nav: pageNav(input.shell, "todo"),
    body: `<main class="todo-reading" id="content" data-theme-id="${escapeHtml(input.shell.theme.id)}" data-theme-revision="${input.shell.theme.revision}">
      <header class="todo-heading"><p>Personal Todo · ${escapeHtml(input.projection.asOfDate)}</p><h1>个人待办</h1><p>网页只读取正式结果。要新增、修改或完成任务，请继续告诉你的 Agent。</p></header>
      <p class="todo-anchor-status" data-anchor-status role="status" tabindex="-1" hidden>没有找到这条待办。</p>
      ${definitions.map(([key, label]) => {
        const items = input.projection.groups[key];
        return `<section class="todo-group" aria-labelledby="todo-${key}"><header><h2 id="todo-${key}">${label}</h2><span>${items.length} 项</span></header>${items.length ? `<ol>${items.map((item: any) => `<li><article id="${escapeHtml(item.id)}" tabindex="-1"><span>${key === "completedToday" ? "已完成" : key === "overdue" ? "已逾期" : "未完成"}</span><div><h3>${escapeHtml(item.title)}</h3>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}</div><time>${escapeHtml(todoDate(item, input.projection.asOfDate, key === "completedToday", input.shell.timeZone))}</time></article></li>`).join("")}</ol>` : '<p class="todo-group__empty">这一组暂时没有事项。</p>'}</section>`;
      }).join("")}
    </main>`,
  });
}

function instruction(setupUrl: string): string {
  return `请帮我把 DailyNews 用起来。\n请先完整阅读 ${setupUrl}，并按说明完成配置。`;
}

function displayTime(value: Date, timeZone: string): string {
  return value.toLocaleString("zh-CN", { timeZone, hour12: false });
}

export function renderOnboardingPage(input: { basePath: string; shell: ReadingShell; csrfToken: string; operationId: string; setupUrl: string }): string {
  const text = instruction(input.setupUrl);
  return shell({
    basePath: input.basePath,
    title: "首次使用",
    page: "onboarding",
    privatePage: true,
    nav: pageNav(input.shell, ""),
    body: `<main class="onboarding-main" id="content">
      <header class="onboarding-heading"><p>第一次使用</p><h1>把这段话发给你的 Agent</h1><p>设置话术不包含 Token。Agent 读完说明并确认客户端能力后，会主动向你索取。</p></header>
      <section class="onboarding-step" aria-labelledby="instruction-title"><div class="step-number">1</div><div><h2 id="instruction-title">复制设置话术</h2><pre data-copy-source="instruction">${escapeHtml(text)}</pre><button class="button" type="button" data-copy="instruction">复制给 Agent</button><p class="copy-status" data-copy-status="instruction" aria-live="polite"></p></div></section>
      <section class="onboarding-step" aria-labelledby="token-title"><div class="step-number">2</div><div><h2 id="token-title">等 Agent 向你索取 Token</h2><p>收到 Agent 请求后再创建。页面加载不会提前生成 Token。</p><form class="inline-form" method="post" action="${escapeHtml(path(input.basePath, "/onboarding/token"))}" data-settings-form novalidate><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="operationId" value="${escapeHtml(input.operationId)}"><label for="onboarding-token-name">Token 名称</label><input class="auth-form__input" id="onboarding-token-name" name="name" value="我的 Agent" maxlength="80" aria-describedby="onboarding-token-help" required><p id="onboarding-token-help" class="form-helper">1–80 个可见字符，用来区分不同 Agent。</p><button class="button" type="submit">创建 Token</button><p class="form-status" data-form-status aria-live="polite"></p></form></div></section>
      <section class="onboarding-finish"><h2>创建后继续留在 Agent 对话里</h2><p>完整 Token 只显示一次。把它发给刚才主动索取的受信任 Agent，然后由 Agent 完成 MCP 工具发现和连接验证。</p><a class="button button--quiet" href="${escapeHtml(path(input.basePath, "/home"))}">先看看示例日报</a><a class="text-link" href="${escapeHtml(path(input.basePath, "/settings/agent"))}">管理 Agent Token →</a></section>
    </main>`,
  });
}

export function renderAgentSettingsPage(input: { basePath: string; shell: ReadingShell; credentials: CredentialRecord[]; csrfToken: string; operationId: string; activeLimit: number }): string {
  const active = input.credentials.filter((item) => item.status === "active");
  return renderSettingsDocument({
    basePath: input.basePath,
    shell: input.shell,
    current: "agent",
    title: "Agent 授权",
    kicker: "Agent Access",
    summary: "这里只显示服务端能够确认的授权与最近请求，不判断 Agent 是否在线。",
    content: `<section class="settings-section"><div class="section-heading"><h2>创建 Agent Token</h2><span>${active.length} / ${input.activeLimit}</span></div>${active.length >= input.activeLimit ? "<p>活动 Token 数量已达上限，请先撤销不再使用的 Token。</p>" : `<p>完整值只在创建成功后显示一次。每个 Agent 使用独立 Token，便于单独轮换或撤销。</p><form class="inline-form" method="post" action="${escapeHtml(path(input.basePath, "/settings/agent/tokens"))}" data-settings-form novalidate><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="operationId" value="${escapeHtml(input.operationId)}"><label for="token-name">Token 名称</label><input class="auth-form__input" id="token-name" name="name" value="我的 Agent" maxlength="80" required><button class="button" type="submit">创建 Token</button><p class="form-status" data-form-status aria-live="polite"></p></form>`}</section><section class="settings-section"><h2>Token 记录</h2>${input.credentials.length ? `<div class="agent-list">${input.credentials.map((item) => `<article><div><p class="paper-label">${item.status === "active" ? "使用中" : item.status === "rotated" ? "已轮换" : "已撤销"}</p><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.tokenHint)} · 创建于 ${escapeHtml(displayTime(item.createdAt, input.shell.timeZone))}</p></div><dl><dt>最近一次请求</dt><dd>${item.lastUsedAt ? escapeHtml(displayTime(item.lastUsedAt, input.shell.timeZone)) : "尚无请求"}</dd></dl>${item.status === "active" ? `<div class="record-actions"><a href="${escapeHtml(path(input.basePath, `/settings/agent/tokens/${item.id}/rotate`))}">轮换</a><a class="danger-link" href="${escapeHtml(path(input.basePath, `/settings/agent/tokens/${item.id}/revoke`))}">撤销</a></div>` : ""}</article>`).join("")}</div>` : "<p>还没有 Agent Token。</p>"}</section><section class="settings-section"><h2>高级接入</h2><a class="text-link" href="${escapeHtml(path(input.basePath, "/settings/advanced"))}">查看 MCP、JSON API 与 OpenAPI →</a></section>`,
  });
}

export function renderAdvancedAccessPage(input: { basePath: string; shell: ReadingShell; apiBaseUrl: string; mcpUrl: string }): string {
  return renderSettingsDocument({
    basePath: input.basePath,
    shell: input.shell,
    current: "advanced",
    title: "高级接入",
    kicker: "Advanced Access",
    summary: "为自己的脚本或高级客户端提供协议地址与机器可读契约。Token 统一在 Agent 授权中管理。",
    content: `<section class="settings-section"><h2>接口地址</h2><dl><div><dt>JSON API</dt><dd><code>${escapeHtml(input.apiBaseUrl)}</code></dd></div><div><dt>MCP</dt><dd><code>${escapeHtml(input.mcpUrl)}</code></dd></div></dl><a class="text-link" href="${escapeHtml(path(input.basePath, "/settings/advanced/openapi.yaml"))}">下载 OpenAPI 契约 →</a></section><section class="settings-section"><h2>Agent Token</h2><p>MCP 与 JSON API 使用同一套 Agent Token。创建、一次性查看、轮换和撤销都在 Agent 授权页面完成。</p><a class="button button--quiet" href="${escapeHtml(path(input.basePath, "/settings/agent"))}">前往 Agent 授权</a></section><section class="settings-section"><h2>高级说明</h2><p>JSON API 使用 Bearer 鉴权和 Idempotency-Key；MCP 使用远程 Streamable HTTP。具体字段以 OpenAPI 与 MCP 工具 Schema 为准。</p></section>`,
  });
}

export function renderCredentialSecretPage(input: { basePath: string; shell: ReadingShell; token: string | null; title: string; returnPath?: string }): string {
  return shell({
    basePath: input.basePath,
    title: input.title,
    page: "agent-settings",
    privatePage: true,
    nav: pageNav(input.shell, "settings"),
    body: `<main class="empty-reading secret-page" id="content" data-secret-return="${escapeHtml(path(input.basePath, input.returnPath ?? "/settings/agent"))}"><p>一次性凭证</p><h1>${escapeHtml(input.title)}</h1>${input.token ? `<p>这是唯一一次显示完整 Token。请把它发给刚才主动向你索取的受信任 Agent；不要公开或发送给其他人。</p><code class="secret-value" data-copy-source="secret">${escapeHtml(input.token)}</code><button class="button" type="button" data-copy="secret">复制 Token</button><p class="copy-status" data-copy-status="secret" aria-live="polite"></p>` : "<p>这个操作已经处理过。为避免重放明文，DailyNews 不会再次显示之前的 Token；如未保存，请重新创建或轮换。</p>"}<a class="text-link" href="${escapeHtml(path(input.basePath, input.returnPath ?? "/settings/agent"))}">我已处理，返回 Agent 授权 →</a></main>`,
  });
}

export function renderNicknameOnboardingPage(input: {
  basePath: string;
  shell: ReadingShell;
  csrfToken: string;
  nickname?: string;
  error?: string;
}): string {
  return shell({
    basePath: input.basePath,
    title: "先写下你的称呼",
    page: "onboarding",
    privatePage: true,
    nav: pageNav(input.shell, ""),
    body: `<main class="onboarding-main onboarding-main--profile" id="content"><header class="onboarding-heading"><p>第一次使用</p><h1>先写下你的称呼</h1><p>之后的私人编辑部会用这个昵称称呼你。它不会从邮箱地址猜测。</p></header><form class="settings-form" method="post" action="${escapeHtml(path(input.basePath, "/onboarding/nickname"))}" data-settings-form novalidate><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><div class="form-field"><label for="nickname">昵称</label><input class="auth-form__input" id="nickname" name="nickname" value="${escapeHtml(input.nickname ?? "")}" maxlength="24" aria-describedby="nickname-help nickname-error"${input.error ? ' aria-invalid="true"' : ""} required autofocus><p id="nickname-help" class="form-helper">1–24 个可见字符，保存后仍可在账户设置中修改。</p>${input.error ? `<p id="nickname-error" class="form-error" role="alert">${escapeHtml(input.error)}</p>` : '<p id="nickname-error" class="form-error" aria-live="polite"></p>'}</div><button class="button" type="submit">保存并继续连接 Agent</button><p class="form-status" data-form-status aria-live="polite"></p></form></main>`,
  });
}

export function renderAccountSettingsPage(input: {
  basePath: string;
  shell: ReadingShell;
  csrfToken: string;
  profile: UserProfile;
  nickname?: string;
  error?: string;
  saved?: boolean;
}): string {
  const nickname = input.nickname ?? input.profile.nickname ?? "";
  return renderSettingsDocument({
    basePath: input.basePath,
    shell: input.shell,
    current: "account",
    title: "账户与安全",
    kicker: "Account",
    summary: "管理浏览器账户的称呼与当前登录会话。Agent 授权在单独的栏目中管理。",
    content: `${input.saved ? '<p class="form-status" role="status">昵称已保存。</p>' : ""}<section class="settings-section"><h2>个人资料</h2><form class="settings-form" method="post" action="${escapeHtml(path(input.basePath, "/settings/account/nickname"))}" data-settings-form novalidate><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><div class="form-field"><label for="account-nickname">昵称</label><input class="auth-form__input" id="account-nickname" name="nickname" value="${escapeHtml(nickname)}" maxlength="24" aria-describedby="account-nickname-help account-nickname-error"${input.error ? ' aria-invalid="true"' : ""} required><p id="account-nickname-help" class="form-helper">1–24 个可见字符。</p>${input.error ? `<p id="account-nickname-error" class="form-error" role="alert">${escapeHtml(input.error)}</p>` : '<p id="account-nickname-error" class="form-error" aria-live="polite"></p>'}</div><button class="button" type="submit">保存昵称</button><p class="form-status" data-form-status aria-live="polite"></p></form></section><section class="settings-section settings-section--spec"><h2>登录身份</h2><dl><div><dt>邮箱</dt><dd>${escapeHtml(input.profile.email)}</dd></div><div><dt>认证方式</dt><dd>邮箱验证码</dd></div></dl></section><section class="settings-section"><h2>当前会话</h2><p>退出只结束当前浏览器会话，不会撤销 Agent 的独立授权。</p><form data-logout-form><button class="button button--quiet" type="submit">退出当前会话</button></form></section>`,
  });
}

export function renderConfirmPage(input: { basePath: string; shell: ReadingShell; title: string; description: string; action: string; csrfToken: string; submitLabel: string; hidden?: Record<string, string>; cancelPath?: string; cancelLabel?: string }): string {
  return shell({
    basePath: input.basePath,
    title: input.title,
    page: "agent-settings",
    privatePage: true,
    nav: pageNav(input.shell, "settings"),
    body: `<main class="empty-reading confirm-page" id="content"><p>确认影响</p><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.description)}</p><form method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}">${Object.entries(input.hidden ?? {}).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("")}<button class="button button--danger" type="submit">${escapeHtml(input.submitLabel)}</button></form><a class="text-link" href="${escapeHtml(path(input.basePath, input.cancelPath ?? "/settings/agent"))}">${escapeHtml(input.cancelLabel ?? "取消并返回")}</a></main>`,
  });
}
