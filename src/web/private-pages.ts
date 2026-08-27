import { compileIssue } from "../../scripts/lib/compiler.js";
import { buildDailyReadingProjection } from "../../scripts/lib/domain/daily-reading.js";
import type { DailyReading, ReadingShell } from "../modules/private-reading/service.js";
import type { CredentialRecord, PairingRecord } from "../modules/agent-access/credential-service.js";

type PageName = "public" | "login" | "onboarding" | "home" | "daily" | "todo" | "settings" | "agent-settings" | "pairing";

interface PageShellOptions {
  basePath: string;
  title: string;
  page: PageName;
  body: string;
  privatePage?: boolean;
  nav?: { publicationId: string; publicationName: string; todoEnabled: boolean; current: string; themeId: string; themeRevision: number };
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
    { key: "daily", href: path(basePath, `/p/${encodeURIComponent(nav.publicationId)}/`), label: nav.publicationName },
    ...(nav.todoEnabled ? [{ key: "todo", href: path(basePath, "/todo/"), label: "个人待办" }] : []),
    { key: "settings", href: path(basePath, "/settings"), label: "编辑部设置" },
  ];
  return `<nav class="product-nav" aria-label="私人空间">
        ${links.map((link) => `<a href="${escapeHtml(link.href)}"${nav.current === link.key ? ' aria-current="page"' : ""}>${escapeHtml(link.label)}</a>`).join("\n        ")}
      </nav>
      <label class="product-nav-select">
        <span>前往</span>
        <select data-page-select>
          ${links.map((link) => `<option value="${escapeHtml(link.href)}"${nav.current === link.key ? " selected" : ""}>${escapeHtml(link.label)}</option>`).join("\n          ")}
        </select>
      </label>`;
}

function shell(options: PageShellOptions): string {
  const basePath = escapeHtml(options.basePath);
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
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light">
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
    publicationId: shellInput.publication.publicationId,
    publicationName: shellInput.publication.displayName,
    todoEnabled: shellInput.todoEnabled,
    current,
    themeId: shellInput.theme.id,
    themeRevision: shellInput.theme.revision,
  };
}

function dailyModule(module: Record<string, any>, index: number): string {
  const item = module.item;
  const source = item.sources?.[0];
  const copy = module.size === "large" ? item.summary : item.brief;
  return `<article class="daily-module daily-module--${escapeHtml(module.size)}" style="--module-span:${Number(module.span)}">
      <header><span>${escapeHtml(item.category ?? "今日编辑")}</span><span>${String(index + 1).padStart(2, "0")}</span></header>
      <h2>${escapeHtml(item.title)}</h2>
      <p>${escapeHtml(copy)}</p>
      ${source ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)} ↗</a>` : ""}
    </article>`;
}

function dailyEdition(projection: any): string {
  let index = 0;
  return projection.rows.map((row: any) => `<div class="daily-row" style="--row-capacity:${row.usedCapacity}">
    ${row.modules.map((module: any) => dailyModule(module, index++)).join("\n    ")}
  </div>`).join("\n");
}

export function renderHomePage(input: {
  basePath: string;
  shell: ReadingShell;
  daily: DailyReading | null;
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
      ${formal && todoItems.length > 0 ? `<section class="home-todo" aria-labelledby="home-todo-title">
        <header><h2 id="home-todo-title">个人待办</h2><a href="${escapeHtml(path(input.basePath, "/todo/"))}">查看全部 →</a></header>
        <ol>${todoItems.map((item: any) => `<li><a href="${escapeHtml(path(input.basePath, `/todo/#${item.id}`))}">${escapeHtml(item.title)}</a><span>${escapeHtml(item.dueDate ?? "暂无日期")}</span></li>`).join("")}</ol>
      </section>` : ""}
      ${!formal ? `<a class="secondary-journey" href="${escapeHtml(path(input.basePath, "/onboarding"))}">把自动日报真正用起来</a>` : ""}
    </main>`,
  });
}

export function renderDailyPage(input: { basePath: string; shell: ReadingShell; daily: DailyReading | null; requestedDate?: string }): string {
  const body = input.daily
    ? `<main class="daily-main" id="content" data-theme-id="${escapeHtml(input.shell.theme.id)}" data-theme-revision="${input.shell.theme.revision}">
      <header class="daily-heading"><div><p>正式日报</p><h1>${escapeHtml(input.shell.publication.displayName)}</h1></div><time datetime="${escapeHtml(input.daily.date)}">${escapeHtml(input.daily.date)}</time></header>
      <section class="daily-edition" aria-label="${escapeHtml(input.daily.date)} 日报内容">${dailyEdition(input.daily.projection)}</section>
    </main>`
    : `<main class="empty-reading" id="content"><p>日报</p><h1>${input.requestedDate ? "没有找到这期正式日报" : "第一份正式日报还没有到达"}</h1><p>${input.requestedDate ? `日期 ${escapeHtml(input.requestedDate)} 没有正式内容，地址没有回退到其他日期。` : "你仍可以先阅读 Home 上的系统示例，或继续完成 Agent 设置。"}</p><a class="button button--quiet" href="${escapeHtml(path(input.basePath, "/home"))}">返回总览</a></main>`;
  return shell({ basePath: input.basePath, title: input.daily?.date ?? "日报", page: "daily", privatePage: true, nav: pageNav(input.shell, "daily"), body });
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

export function renderSettingsPage(input: { basePath: string; shell: ReadingShell; csrfToken: string; todoCounts?: { total: number; open: number } }): string {
  return shell({
    basePath: input.basePath,
    title: "编辑部设置",
    page: "settings",
    privatePage: true,
    nav: pageNav(input.shell, "settings"),
    body: `<main class="settings-main" id="content">
      <header class="settings-heading"><p>你的私人编辑部</p><h1>编辑部设置</h1><p>这里只显示浏览器能够确认的站点、Todo、授权和账户事实。</p></header>
      <section class="settings-section" aria-labelledby="settings-publication"><h2 id="settings-publication">日报站点</h2><dl><div><dt>站点名称</dt><dd>${escapeHtml(input.shell.publication.displayName)}</dd></div><div><dt>私有路径</dt><dd>/p/${escapeHtml(input.shell.publication.publicationId)}/</dd></div><div><dt>当前主题</dt><dd>${escapeHtml(input.shell.theme.id)} · ${input.shell.theme.revision}</dd></div></dl><a class="button button--quiet" href="${escapeHtml(path(input.basePath, `/p/${encodeURIComponent(input.shell.publication.publicationId)}/`))}">打开站点</a></section>
      <section class="settings-section" aria-labelledby="settings-todo"><h2 id="settings-todo">Personal Todo</h2><p class="paper-label">${input.shell.todoEnabled ? "已启用" : "未启用"}</p><p>${input.shell.todoEnabled ? "关闭后 Agent 新写入会失败；现有任务会保留。" : "启用后 Agent 才能保存个人任务。"}</p>${input.todoCounts ? `<p>当前共有 ${input.todoCounts.total} 项，其中 ${input.todoCounts.open} 项未完成。</p>` : ""}${input.shell.todoEnabled ? `<a class="button button--danger" href="${escapeHtml(path(input.basePath, "/settings/todo/disable"))}">关闭 Personal Todo</a><a class="text-link" href="${escapeHtml(path(input.basePath, "/todo/"))}">查看个人待办 →</a>` : `<form method="post" action="${escapeHtml(path(input.basePath, "/settings/todo/enable"))}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><button class="button" type="submit">启用并继续</button></form>`}</section>
      <section class="settings-section" aria-labelledby="settings-agents"><h2 id="settings-agents">Agent 授权</h2><p>管理每条独立授权与新的 Agent 连接。</p><a class="button button--quiet" href="${escapeHtml(path(input.basePath, "/settings/agent"))}">管理 Agent 授权</a></section>
      <section class="settings-section" aria-labelledby="settings-account"><h2 id="settings-account">账户与安全</h2><p>浏览器会话与 Agent 授权彼此独立。</p><form data-logout-form><button class="text-link" type="submit">退出登录</button></form></section>
      <section class="settings-section" aria-labelledby="settings-advanced"><h2 id="settings-advanced">高级接入</h2><p>脚本与特殊客户端可以使用手动 Token、JSON API 和 OpenAPI 契约。</p><a class="text-link" href="${escapeHtml(path(input.basePath, "/settings/agent/manual-tokens"))}">进入手动接入 →</a></section>
    </main>`,
  });
}

export function renderTodoSettingsPage(input: { basePath: string; shell: ReadingShell; csrfToken: string; todoCounts?: { total: number; open: number }; reason?: string }): string {
  return shell({
    basePath: input.basePath,
    title: "Personal Todo 设置",
    page: "settings",
    privatePage: true,
    nav: pageNav(input.shell, "settings"),
    body: `<main class="settings-main" id="content">
      <header class="settings-heading"><p>编辑部设置</p><h1>Personal Todo</h1><p>个人待办只读取正式 Todo State，所有修改仍由你的 Agent 完成。</p></header>
      ${input.reason === "todo-disabled" ? '<p class="form-status" role="status">个人待办尚未启用。确认启用后，再回到 Agent 继续刚才的任务。</p>' : ""}
      <section class="settings-section" aria-labelledby="todo-status"><h2 id="todo-status">当前状态</h2><p class="paper-label">${input.shell.todoEnabled ? "已启用" : "未启用"}</p><p>${input.shell.todoEnabled ? "Agent 可以读取和提交个人任务。关闭后新写入会失败，但已有任务仍会保留。" : "启用后 Agent 才能保存个人任务；启用操作不会自动创建任务。"}</p>${input.todoCounts ? `<p>当前共有 ${input.todoCounts.total} 项，其中 ${input.todoCounts.open} 项未完成。这里不展示任务标题。</p>` : ""}${input.shell.todoEnabled ? `<a class="button button--danger" href="${escapeHtml(path(input.basePath, "/settings/todo/disable"))}">关闭 Personal Todo</a><a class="text-link" href="${escapeHtml(path(input.basePath, "/todo/"))}">查看个人待办 →</a>` : `<form method="post" action="${escapeHtml(path(input.basePath, "/settings/todo/enable"))}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><button class="button" type="submit">启用并继续</button></form>`}</section>
      <a class="text-link" href="${escapeHtml(path(input.basePath, "/settings"))}">返回编辑部设置</a>
    </main>`,
  });
}

function instruction(setupUrl: string): string {
  return `请帮我把 DailyNews 用起来。\n请只从 ${setupUrl} 读取当前接入说明，并按说明帮我完成配置。\n读完后先向我要页面当前显示的配对码，不要让我手工配置 PAT、MCP、API、Cron 或完整提示词。\n连接成功后，继续问我想长期关注什么、希望什么时候更新；由你在自己的运行环境中建立定时任务，并立即生成第一份日报让我确认。\n不要在回复、日志或项目文件中输出长期凭证；只询问真正缺失的信息，其他使用安全默认值。`;
}

function pairingStatus(status: PairingRecord["status"]): string {
  return ({ pending: "等待 Agent", claimed: "Agent 正在准备连接", verified: "已授权", cancelled: "没有完成", expired: "没有完成" })[status];
}

function displayTime(value: Date, timeZone: string): string {
  return value.toLocaleString("zh-CN", { timeZone, hour12: false });
}

export function renderOnboardingPage(input: { basePath: string; shell: ReadingShell; pairing: PairingRecord & { code?: string | null }; csrfToken: string; setupUrl: string; firstUse?: boolean; refreshed?: boolean }): string {
  const text = instruction(input.setupUrl);
  const canRefresh = input.pairing.status === "pending" || input.pairing.status === "expired";
  const refreshForm = canRefresh
    ? `<form method="post" action="${escapeHtml(path(input.basePath, `/settings/agent/connections/${input.pairing.id}/pair/refresh`))}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><button class="button button--quiet" type="submit"${input.refreshed ? " autofocus" : ""}>换一个配对码</button></form>`
    : "";
  const pairingBody = input.pairing.code
    ? `<div class="pairing-code" data-copy-source="pairing">${escapeHtml(input.pairing.code)}</div><p class="pairing-expiry"><time data-pairing-expiry datetime="${input.pairing.expiresAt.toISOString()}">有效至 ${input.pairing.expiresAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: input.shell.timeZone })}</time></p><div class="pairing-actions"><button class="button" type="button" data-copy="pairing">复制配对码</button>${refreshForm}</div><p class="copy-status" data-copy-status="pairing" aria-live="polite">${input.refreshed ? "旧配对码已失效，请只发送当前码。" : ""}</p>`
    : `<p>Agent 已经开始认领，旧码已隐藏。${input.pairing.status === "claimed" ? "如需重试，请先取消本次连接。" : ""}</p>`;
  const cancelForm = input.pairing.status === "claimed"
    ? `<form method="post" action="${escapeHtml(path(input.basePath, `/settings/agent/connections/${input.pairing.id}/pair/cancel`))}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><button class="button button--quiet" type="submit">取消并换码</button></form>`
    : "";
  return shell({
    basePath: input.basePath,
    title: "首次使用",
    page: "onboarding",
    privatePage: true,
    nav: pageNav(input.shell, ""),
    body: `<main class="onboarding-main" id="content" data-pairing-id="${escapeHtml(input.pairing.id)}" data-pairing-status="${escapeHtml(input.pairing.status)}">
      <header class="onboarding-heading"><p>${input.firstUse === false ? "新增独立授权" : "第一次连接"}</p><h1>${input.firstUse === false ? "连接另一个 Agent" : "把这段话发给你的 Agent"}</h1><p>先复制完整话术。等 Agent 读完官方说明并主动索要时，再单独发送当前配对码。</p></header>
      <section class="onboarding-step" aria-labelledby="instruction-title"><div class="step-number">1</div><div><h2 id="instruction-title">复制设置话术</h2><pre data-copy-source="instruction">${escapeHtml(text)}</pre><button class="button" type="button" data-copy="instruction">复制给 Agent</button><p class="copy-status" data-copy-status="instruction" aria-live="polite"></p></div></section>
      <section class="onboarding-step" aria-labelledby="pairing-title"><div class="step-number">2</div><div><h2 id="pairing-title">等 Agent 向你索要配对码</h2><p class="paper-label" data-pairing-label>${escapeHtml(pairingStatus(input.pairing.status))}</p>${pairingBody}${cancelForm}<p class="security-note">配对码短时有效，只能准备这一条连接；它不包含长期 PAT，也不能读取你的数据。</p></div></section>
      <section class="onboarding-finish"><h2>${input.pairing.status === "verified" ? "Agent 已通过验证" : "连接后继续留在 Agent 对话里"}</h2><p>${input.pairing.status === "verified" ? "现在回到 Agent，继续告诉它长期关注什么，以及希望什么时候更新。" : "授权只是第一步。Agent 完成验证后，还会继续询问关注内容和更新时间，并立即生成第一份日报。"}</p><a class="button button--quiet" href="${escapeHtml(path(input.basePath, "/home"))}">先看看示例日报</a><a class="text-link" href="${escapeHtml(path(input.basePath, "/settings/agent/manual-tokens"))}">无法自动连接？查看手动步骤</a></section>
    </main>`,
  });
}

export function renderAgentSettingsPage(input: { basePath: string; shell: ReadingShell; credentials: CredentialRecord[]; pairings: Array<PairingRecord & { code?: string | null }>; csrfToken: string; operationId: string; activeLimit: number }): string {
  const active = input.credentials.filter((item) => item.status === "active");
  const pending = input.pairings.find((item) => item.status !== "verified" && item.status !== "cancelled");
  return shell({
    basePath: input.basePath,
    title: "Agent 授权",
    page: "agent-settings",
    privatePage: true,
    nav: pageNav(input.shell, "settings"),
    body: `<main class="settings-main" id="content"><header class="settings-heading"><p>Agent Access</p><h1>Agent 授权</h1><p>这里只显示服务端能够确认的授权与最近请求，不判断 Agent 是否在线。</p></header><section class="settings-section"><div class="section-heading"><h2>当前授权</h2><span>${active.length} / ${input.activeLimit}</span></div>${active.length ? `<div class="agent-list">${active.map((item) => `<article><div><p class="paper-label">已授权</p><h3>${escapeHtml(item.name)}</h3><p>创建于 ${escapeHtml(displayTime(item.createdAt, input.shell.timeZone))}</p></div><dl><dt>最近一次请求</dt><dd>${item.lastUsedAt ? escapeHtml(displayTime(item.lastUsedAt, input.shell.timeZone)) : "尚无请求"}</dd></dl><a class="danger-link" href="${escapeHtml(path(input.basePath, `/settings/agent/connections/${item.id}/remove`))}">移除 Agent</a></article>`).join("")}</div>` : "<p>还没有已授权的 Agent。</p>"}</section><section class="settings-section"><h2>连接另一个 Agent</h2>${active.length >= input.activeLimit ? "<p>授权数量已达上限，请先移除不再使用的 Agent。</p>" : pending ? `<a class="button" href="${escapeHtml(path(input.basePath, `/settings/agent/connections/${pending.id}/pair`))}">继续当前连接</a>` : `<form class="inline-form" method="post" action="${escapeHtml(path(input.basePath, "/settings/agent/connections"))}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="operationId" value="${escapeHtml(input.operationId)}"><label for="connection-name">连接名称</label><input class="auth-form__input" id="connection-name" name="name" value="我的 Agent" maxlength="80" required><button class="button" type="submit">开始连接</button></form>`}</section><section class="settings-section"><h2>高级接入</h2><a class="text-link" href="${escapeHtml(path(input.basePath, "/settings/agent/manual-tokens"))}">手动 Token 与接口地址 →</a></section></main>`,
  });
}

export function renderAdvancedAccessPage(input: { basePath: string; shell: ReadingShell; credentials: CredentialRecord[]; csrfToken: string; operationId: string; apiBaseUrl: string; mcpUrl: string }): string {
  return shell({
    basePath: input.basePath,
    title: "手动接入",
    page: "agent-settings",
    privatePage: true,
    nav: pageNav(input.shell, "settings"),
    body: `<main class="settings-main" id="content"><header class="settings-heading"><p>Advanced Access</p><h1>手动接入</h1><p>仅用于自己的脚本或不能自动配置的客户端。普通 Agent 接入不需要这里的内容。</p></header><section class="settings-section"><h2>接口地址</h2><dl><div><dt>JSON API</dt><dd><code>${escapeHtml(input.apiBaseUrl)}</code></dd></div><div><dt>MCP</dt><dd><code>${escapeHtml(input.mcpUrl)}</code></dd></div></dl><a class="text-link" href="${escapeHtml(path(input.basePath, "/settings/agent/openapi.yaml"))}">下载 OpenAPI 契约 →</a></section><section class="settings-section"><h2>创建个人访问令牌</h2><p>完整令牌只在本次成功响应中显示一次。每个客户端使用独立令牌，便于单独撤销。</p><form class="inline-form" method="post" action="${escapeHtml(path(input.basePath, "/settings/agent/manual-tokens"))}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="operationId" value="${escapeHtml(input.operationId)}"><label for="token-name">连接名称</label><input class="auth-form__input" id="token-name" name="name" maxlength="80" required><button class="button" type="submit">创建令牌</button></form></section><section class="settings-section"><h2>令牌记录</h2>${input.credentials.length ? `<div class="agent-list">${input.credentials.map((item) => `<article><div><p class="paper-label">${escapeHtml(item.status)}</p><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.tokenHint)}</p></div><dl><dt>最近请求</dt><dd>${item.lastUsedAt ? escapeHtml(displayTime(item.lastUsedAt, input.shell.timeZone)) : "尚无请求"}</dd></dl>${item.status === "active" ? `<div class="record-actions"><a href="${escapeHtml(path(input.basePath, `/settings/agent/manual-tokens/${item.id}/rotate`))}">轮换</a><a class="danger-link" href="${escapeHtml(path(input.basePath, `/settings/agent/manual-tokens/${item.id}/revoke`))}">撤销</a></div>` : ""}</article>`).join("")}</div>` : "<p>还没有手动令牌。</p>"}</section></main>`,
  });
}

export function renderCredentialSecretPage(input: { basePath: string; shell: ReadingShell; token: string | null; title: string }): string {
  return shell({
    basePath: input.basePath,
    title: input.title,
    page: "agent-settings",
    privatePage: true,
    nav: pageNav(input.shell, "settings"),
    body: `<main class="empty-reading secret-page" id="content"><p>一次性凭证</p><h1>${escapeHtml(input.title)}</h1>${input.token ? `<p>这是唯一一次显示完整令牌。请立即保存到客户端的安全凭证存储，不要发送到聊天、日志或项目文件。</p><code class="secret-value" data-copy-source="secret">${escapeHtml(input.token)}</code><button class="button" type="button" data-copy="secret">复制令牌</button><p class="copy-status" data-copy-status="secret" aria-live="polite"></p>` : "<p>这个操作已经处理过。为避免重放明文，DailyNews 不会再次显示之前的令牌；如未保存，请重新创建或轮换。</p>"}<a class="text-link" href="${escapeHtml(path(input.basePath, "/settings/agent/manual-tokens"))}">我已处理，返回高级接入 →</a></main>`,
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
