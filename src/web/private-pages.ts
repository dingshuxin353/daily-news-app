import type { ReadingShell } from "../modules/private-reading/service.js";
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
