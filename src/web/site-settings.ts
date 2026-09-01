import { type Context, type Hono } from "hono";
import type { IdentityService } from "../modules/identity/auth.js";
import { ProfileError, type UserProfileService } from "../modules/identity/profile-service.js";
import type { PrivateReadingService, ReadingShell } from "../modules/private-reading/service.js";
import {
  SiteManagementError,
  type ManagedPublication,
  type SiteManagementService,
  type SiteManagementSnapshot,
} from "../modules/site-management/service.js";
import type { BrowserTheme, SiteThemeCatalogService } from "../modules/site-management/theme-catalog.js";
import type { PostgresTenancyStore, TenantContext } from "../adapters/postgres/tenancy.js";
import type { CloudFileConfig } from "../cloud/config.js";
import { AgentAccessError } from "../modules/agent-access/credential-service.js";
import { assertBrowserMutation, createSettingsCsrfToken, readSettingsBody } from "./settings-security.js";
import {
  escapeHtml,
  renderAccountSettingsPage,
  renderConfirmPage,
  renderSettingsDocument,
} from "./private-pages.js";
import { renderNicknameOnboardingPage } from "./react/render.js";

export interface SiteSettingsDependencies {
  basePath: string;
  origin: string;
  csrfSecret: string;
  identity: IdentityService;
  tenancy: PostgresTenancyStore;
  privateReading: PrivateReadingService;
  defaults: CloudFileConfig["defaults"];
  service: SiteManagementService;
  themes: SiteThemeCatalogService;
  profiles: UserProfileService;
  publicationLimit: number;
  clientIpResolver: (context: Context) => string;
  requestOriginResolver: (context: Context) => string | null;
  requestBodyLimitBytes: number;
}

interface BrowserAccess {
  tenant: TenantContext;
  sessionId: string;
  userId: string;
  csrfToken: string;
}

const path = (basePath: string, pathname: string) => `${basePath}${pathname}`;

function themeStyle(theme: BrowserTheme): string {
  return `--preview-background:${theme.preview.background};--preview-text:${theme.preview.text};--preview-muted:${theme.preview.muted};--preview-accent:${theme.preview.accent};--preview-rule:${theme.preview.rule}`;
}

function themePreview(theme: BrowserTheme, modifier = ""): string {
  return `<span class="theme-preview${modifier ? ` ${modifier}` : ""}" style="${escapeHtml(themeStyle(theme))}" aria-hidden="true"><i></i><b></b><em></em><small></small></span>`;
}

function themeOptions(input: {
  themes: BrowserTheme[];
  selected: { mode: "inherit" } | { mode: "override"; themeId: string };
  allowInherit: boolean;
  homeThemeName?: string;
}): string {
  const inherit = input.allowInherit
    ? `<label class="theme-choice"><input type="radio" name="themeMode" value="inherit"${input.selected.mode === "inherit" ? " checked" : ""} required><span class="theme-choice__copy"><strong>跟随 Home</strong><small>${escapeHtml(input.homeThemeName ?? "随 Home 主题更新")}</small></span></label>`
    : "";
  return `<fieldset class="theme-choices"><legend>主题</legend><p>选择只影响这个站点的正式阅读页面。</p>${inherit}${input.themes.map((theme, index) => `<label class="theme-choice"><input type="radio" name="themeMode" value="override:${escapeHtml(theme.themeId)}"${input.selected.mode === "override" && input.selected.themeId === theme.themeId ? " checked" : ""}${!input.allowInherit && index === 0 ? " required" : ""}>${themePreview(theme)}<span class="theme-choice__copy"><strong>${escapeHtml(theme.name)}</strong><small>${theme.source === "official" ? "DailyNews 官方" : "你的自定义主题"}</small></span></label>`).join("")}</fieldset>`;
}

function formError(error: unknown): { message: string; status: 400 | 403 | 404 | 409 | 503 } {
  if (error instanceof AgentAccessError) {
    return { message: error.message, status: error.status === 403 ? 403 : 400 };
  }
  if (error instanceof ProfileError) {
    if (error.code === "PROFILE_INPUT_INVALID") return { message: "昵称需要是 1–24 个可见字符。", status: 400 };
    if (error.code === "PROFILE_TARGET_NOT_FOUND") return { message: "没有找到这个账户。", status: 404 };
    return { message: "账户设置暂时无法保存，请稍后重试。", status: 503 };
  }
  if (error instanceof SiteManagementError) {
    const messages: Partial<Record<typeof error.code, string>> = {
      SITE_INPUT_INVALID: "请检查名称、地址和主题选择后重试。",
      SITE_NAME_CONFLICT: "这个站点名称已经在使用。",
      SITE_ID_CONFLICT: "这个私有地址已经在使用。",
      SITE_LIMIT_REACHED: "日报站点数量已达上限；停用的站点也计入上限。",
      SITE_TARGET_NOT_FOUND: "没有找到这个日报站点。",
      SITE_LAST_ACTIVE: "至少需要保留一个启用中的日报站点。",
      SITE_THEME_NOT_FOUND: "所选主题已经不可用，请重新选择。",
      SITE_STORAGE_FAILED: "设置暂时无法保存，请稍后重试。",
    };
    const status = error.code === "SITE_TARGET_NOT_FOUND" ? 404
      : error.code === "SITE_INPUT_INVALID" ? 400
      : error.code === "SITE_STORAGE_FAILED" ? 503
      : 409;
    return { message: messages[error.code] ?? "设置暂时无法保存，请稍后重试。", status };
  }
  return { message: "服务暂时不可用，请稍后重试。", status: 503 };
}

function publicationTheme(body: Record<string, unknown>): { mode: "inherit" } | { mode: "override"; themeId: string } {
  if (body.themeMode === "inherit") return { mode: "inherit" };
  if (typeof body.themeMode === "string" && body.themeMode.startsWith("override:")) {
    return { mode: "override", themeId: body.themeMode.slice("override:".length) };
  }
  return { mode: "override", themeId: "" };
}

function publicationCard(input: {
  basePath: string;
  publication: ManagedPublication;
  csrfToken: string;
  index: number;
  total: number;
  themes: BrowserTheme[];
  homeThemeId: string;
}): string {
  const { basePath, publication, csrfToken, index, total } = input;
  const routeId = encodeURIComponent(publication.publicationId);
  const active = publication.status === "active";
  const effectiveThemeId = publication.theme.mode === "inherit" ? input.homeThemeId : publication.theme.themeId;
  const effectiveTheme = input.themes.find(({ themeId }) => themeId === effectiveThemeId);
  if (!effectiveTheme) throw new Error("effective browser theme is unavailable");
  return `<article class="site-card${active ? "" : " site-card--inactive"}" id="site-${routeId}" tabindex="-1"><header><div><p class="paper-label">${publication.isPrimary ? "首要日报" : active ? "启用中" : "已停用"}</p><h3>${escapeHtml(publication.name)}</h3></div><code>/p/${escapeHtml(publication.publicationId)}/</code></header>${themePreview(effectiveTheme, "theme-preview--site")}<p>${publication.theme.mode === "inherit" ? `跟随 Home · ${escapeHtml(effectiveTheme.name)}` : `独立主题 · ${escapeHtml(effectiveTheme.name)}`}</p><div class="site-card__actions"><a class="button button--quiet" href="${escapeHtml(path(basePath, `/settings/sites/${routeId}`))}">配置</a><a class="text-link" href="${escapeHtml(path(basePath, `/p/${routeId}/`))}">打开</a>${active ? `<form method="post" action="${escapeHtml(path(basePath, `/settings/sites/${routeId}/move`))}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="direction" value="up"><button class="icon-button" type="submit" aria-label="上移 ${escapeHtml(publication.name)}"${index === 0 ? " disabled" : ""}>↑</button></form><form method="post" action="${escapeHtml(path(basePath, `/settings/sites/${routeId}/move`))}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="direction" value="down"><button class="icon-button" type="submit" aria-label="下移 ${escapeHtml(publication.name)}"${index === total - 1 ? " disabled" : ""}>↓</button></form>` : ""}</div></article>`;
}

function sitesPage(input: {
  basePath: string;
  shell: ReadingShell;
  snapshot: SiteManagementSnapshot;
  csrfToken: string;
  publicationLimit: number;
  themes: BrowserTheme[];
  reason?: string;
  updated?: string;
  created?: ManagedPublication;
}): string {
  const active = input.snapshot.publications.filter(({ status }) => status === "active");
  const inactive = input.snapshot.publications.filter(({ status }) => status === "inactive");
  const atLimit = input.snapshot.publications.length >= input.publicationLimit;
  const instruction = input.created
    ? `请继续使用已有的 DailyNews 连接，为“${input.created.name}”（私有地址 /p/${input.created.publicationId}/）设置长期关注内容与更新时间，并立即生成第一份日报让我确认。`
    : null;
  const homeTheme = input.themes.find(({ themeId }) => themeId === input.snapshot.home.themeId);
  if (!homeTheme) throw new Error("Home browser theme is unavailable");
  const updates: Record<string, string> = {
    moved: "日报顺序已更新；首要日报会随第一项同步变化。",
    disabled: "日报站点已停用；已有正式内容仍可阅读。",
    restored: "日报站点已恢复，并排在启用列表末尾。",
    "todo-disabled": "Personal Todo 已关闭；已有正式数据仍会保留。",
  };
  return renderSettingsDocument({
    basePath: input.basePath,
    shell: input.shell,
    current: "sites",
    title: "日报站点",
    kicker: "Site Index",
    summary: "Home 固定在最前；启用中的日报按这里的顺序排列，第一项就是 Agent 默认写入目标。",
    content: `${input.reason === "todo-disabled" ? '<p class="form-status" role="status">Personal Todo 尚未启用。请在本页末尾确认启用。</p>' : ""}${input.updated && updates[input.updated] ? `<p class="form-status" role="status">${updates[input.updated]}</p>` : ""}${instruction ? `<section class="created-instruction" aria-labelledby="created-title"><p class="paper-label">站点已创建</p><h2 id="created-title">把下一步交给已有 Agent</h2><pre data-copy-source="site-instruction">${escapeHtml(instruction)}</pre><button class="button" type="button" data-copy="site-instruction">复制给 Agent</button><p class="copy-status" data-copy-status="site-instruction" aria-live="polite"></p></section>` : ""}<section class="settings-section settings-section--home"><div><p class="paper-label">固定入口</p><h2>${escapeHtml(input.snapshot.home.name)}</h2><code>/home</code></div><div class="site-theme-summary">${themePreview(homeTheme, "theme-preview--site")}<p>${escapeHtml(homeTheme.name)}</p></div><div class="site-card__actions"><a class="button button--quiet" href="${escapeHtml(path(input.basePath, "/settings/sites/home"))}">配置 Home</a><a class="text-link" href="${escapeHtml(path(input.basePath, "/home"))}">打开</a></div></section><section class="settings-section"><div class="section-heading"><div><p class="paper-label">启用中</p><h2>日报列表</h2></div><span>${input.snapshot.publications.length} / ${input.publicationLimit}</span></div><div class="site-card-list">${active.map((publication, index) => publicationCard({ basePath: input.basePath, publication, csrfToken: input.csrfToken, index, total: active.length, themes: input.themes, homeThemeId: input.snapshot.home.themeId })).join("")}</div>${atLimit ? '<p class="form-helper">数量已达上限；停用项也会计入上限。</p>' : `<a class="button" href="${escapeHtml(path(input.basePath, "/settings/sites/new"))}">新建日报站点</a>`}</section>${inactive.length ? `<section class="settings-section"><p class="paper-label">保留内容</p><h2>已停用</h2><p>停用项不能接收新写入，但已有正式日报仍可阅读。</p><div class="site-card-list">${inactive.map((publication) => publicationCard({ basePath: input.basePath, publication, csrfToken: input.csrfToken, index: 0, total: 0, themes: input.themes, homeThemeId: input.snapshot.home.themeId })).join("")}</div></section>` : ""}<section class="settings-section todo-setting-row" id="personal-todo" tabindex="-1"><div><p class="paper-label">固定能力</p><h2>Personal Todo</h2><p>${input.snapshot.todo.enabled ? "Agent 可以读取和提交个人任务。关闭后已有正式内容会保留。" : "默认关闭；启用后 Agent 才能保存个人任务。"}</p><p>${input.snapshot.todo.hasFormalData ? "已保留正式 Todo 数据，本页不读取任务正文。" : "尚无正式 Todo 数据。"}</p></div><div class="site-card__actions">${input.snapshot.todo.enabled ? `<a class="button button--danger" href="${escapeHtml(path(input.basePath, "/settings/sites/todo/disable"))}">关闭</a><a class="text-link" href="${escapeHtml(path(input.basePath, "/todo/"))}">打开</a>` : `<form method="post" action="${escapeHtml(path(input.basePath, "/settings/sites/todo/enable"))}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><button class="button" type="submit">启用</button></form>`}</div></section>`,
  });
}

function homePage(input: { basePath: string; shell: ReadingShell; snapshot: SiteManagementSnapshot; themes: BrowserTheme[]; csrfToken: string; name?: string; themeId?: string; error?: string; saved?: boolean }): string {
  const themeId = input.themeId ?? input.snapshot.home.themeId;
  return renderSettingsDocument({
    basePath: input.basePath, shell: input.shell, current: "sites", title: "配置 Home", kicker: "Home", summary: "Home 是私人编辑部的固定首页，名称和主题会影响所有跟随 Home 的日报站点。",
    content: `${input.saved ? '<p class="form-status" role="status">Home 设置已保存。</p>' : ""}<form class="settings-form settings-section" method="post" action="${escapeHtml(path(input.basePath, "/settings/sites/home"))}" data-settings-form novalidate><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><div class="form-field"><label for="home-name">Home 名称</label><input class="auth-form__input" id="home-name" name="name" value="${escapeHtml(input.name ?? input.snapshot.home.name)}" maxlength="40"${input.error ? ' aria-invalid="true"' : ""} required><p class="form-helper">1–40 个可见字符。</p></div><div class="form-field"><label for="home-path">固定路径</label><input class="auth-form__input" id="home-path" value="/home" readonly></div>${themeOptions({ themes: input.themes, selected: { mode: "override", themeId }, allowInherit: false })}${input.error ? `<p class="form-error" role="alert">${escapeHtml(input.error)}</p>` : ""}<button class="button" type="submit">保存 Home</button><p class="form-status" data-form-status aria-live="polite"></p></form>`,
  });
}

function publicationFormPage(input: { basePath: string; shell: ReadingShell; themes: BrowserTheme[]; csrfToken: string; mode: "new" | "edit"; publication?: ManagedPublication; name?: string; publicationId?: string; theme?: { mode: "inherit" } | { mode: "override"; themeId: string }; error?: string; saved?: boolean }): string {
  const name = input.name ?? input.publication?.name ?? "";
  const publicationId = input.publicationId ?? input.publication?.publicationId ?? "";
  const theme = input.theme ?? input.publication?.theme ?? { mode: "inherit" as const };
  const edit = input.mode === "edit";
  return renderSettingsDocument({
    basePath: input.basePath, shell: input.shell, current: "sites", title: edit ? `配置 ${input.publication?.name ?? "日报站点"}` : "新建日报站点", kicker: edit ? "Publication" : "New Publication", summary: edit ? "地址创建后保持不变；名称与主题可以一起安全保存。" : "先建立一个空站点，再把清晰的设置话术交给已有 Agent。",
    content: `${input.saved ? '<p class="form-status" role="status">站点设置已保存。</p>' : ""}<form class="settings-form settings-section" method="post" action="${escapeHtml(path(input.basePath, edit ? `/settings/sites/${encodeURIComponent(publicationId)}` : "/settings/sites/new"))}" data-settings-form novalidate><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><div class="form-field"><label for="publication-name">站点名称</label><input class="auth-form__input" id="publication-name" name="name" value="${escapeHtml(name)}" maxlength="40"${input.error ? ' aria-invalid="true"' : ""} required><p class="form-helper">1–40 个可见字符。</p></div><div class="form-field"><label for="publication-id">私有地址</label><div class="path-input"><span>/p/</span><input class="auth-form__input" id="publication-id" name="publicationId" value="${escapeHtml(publicationId)}" pattern="[a-z0-9]+(?:-[a-z0-9]+)*"${input.error ? ' aria-invalid="true"' : ""}${edit ? " readonly" : " required"}><span>/</span></div><p class="form-helper">只使用小写字母、数字和单个连字符；创建后不可修改。</p></div>${themeOptions({ themes: input.themes, selected: theme, allowInherit: true, homeThemeName: "跟随当前 Home 主题" })}${input.error ? `<p class="form-error" role="alert">${escapeHtml(input.error)}</p>` : ""}<button class="button" type="submit">${edit ? "保存站点" : "创建站点"}</button><p class="form-status" data-form-status aria-live="polite"></p></form>${edit ? `<section class="settings-section settings-section--danger"><h2>${input.publication?.status === "active" ? "停用站点" : "恢复站点"}</h2><p>${input.publication?.status === "active" ? "停用会拒绝 Agent 新写入；已有正式日报仍可阅读。" : "恢复后会排在启用列表末尾，并重新允许 Agent 写入。"}</p>${input.publication?.status === "active" ? `<a class="button button--danger" href="${escapeHtml(path(input.basePath, `/settings/sites/${encodeURIComponent(publicationId)}/status/disable`))}">停用这个站点</a>` : `<form method="post" action="${escapeHtml(path(input.basePath, `/settings/sites/${encodeURIComponent(publicationId)}/status/restore`))}"><input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}"><button class="button" type="submit">恢复站点</button></form>`}</section>` : ""}`,
  });
}

function publicationLimitPage(input: { basePath: string; shell: ReadingShell; publicationLimit: number }): string {
  return renderSettingsDocument({
    basePath: input.basePath,
    shell: input.shell,
    current: "sites",
    title: "无法新建日报站点",
    kicker: "Publication Limit",
    summary: `当前 Space 已有 ${input.publicationLimit} 份日报站点；停用项也计入上限。`,
    content: `<section class="settings-section"><h2>先整理现有站点</h2><p>停用不会释放名额，因为既有正式内容仍需保留。DailyNews 当前不提供物理删除；请返回日报站点查看现有配置。</p><a class="button button--quiet" href="${escapeHtml(path(input.basePath, "/settings/sites"))}">返回日报站点</a></section>`,
  });
}

function catalogPage(input: { basePath: string; shell: ReadingShell; themes: BrowserTheme[] }): string {
  return renderSettingsDocument({
    basePath: input.basePath, shell: input.shell, current: "themes", title: "主题库", kicker: "Theme Catalog", summary: "这里是只读目录。选择主题请回到 Home 或具体日报站点的配置页。",
    content: `<section class="theme-catalog" aria-label="可用主题">${input.themes.map((theme) => `<article class="theme-catalog-card">${themePreview(theme)}<div><p class="paper-label">${theme.source === "official" ? "DailyNews 官方" : "你的自定义主题"}</p><h2>${escapeHtml(theme.name)}</h2></div></article>`).join("")}</section>`,
  });
}

export function registerSiteSettingsRoutes(app: Hono, dependencies: SiteSettingsDependencies): void {
  const route = (pathname: string) => path(dependencies.basePath, pathname);

  async function browserAccess(context: Context): Promise<BrowserAccess | Response> {
    const session = await dependencies.identity.getSession(context.req.raw, dependencies.clientIpResolver(context));
    if (!session) {
      return context.redirect(`${route("/login")}?returnTo=${encodeURIComponent(`${context.req.path}${new URL(context.req.url).search}`)}`, 303);
    }
    const tenant = await dependencies.tenancy.ensureSpaceForUser(session.user.id, dependencies.defaults);
    return {
      tenant,
      sessionId: session.session.id,
      userId: session.user.id,
      csrfToken: createSettingsCsrfToken(dependencies.csrfSecret, session.session.id, session.user.id),
    };
  }

  async function browserMutation(context: Context): Promise<{ access: BrowserAccess; body: Record<string, unknown> } | Response> {
    const access = await browserAccess(context);
    if (access instanceof Response) return access;
    const body = await readSettingsBody(context.req.raw, dependencies.requestBodyLimitBytes);
    assertBrowserMutation({ request: context.req.raw, requestOrigin: dependencies.requestOriginResolver(context), configuredOrigin: dependencies.origin, csrfSecret: dependencies.csrfSecret, sessionId: access.sessionId, userId: access.userId, body });
    return { access, body };
  }

  async function baseData(access: BrowserAccess): Promise<{ shell: ReadingShell; snapshot: SiteManagementSnapshot; themes: BrowserTheme[] }> {
    const [shell, snapshot, themes] = await Promise.all([dependencies.privateReading.readShell(access.tenant), dependencies.service.read(access.tenant), dependencies.themes.list(access.tenant)]);
    return { shell, snapshot, themes };
  }

  app.get(route("/settings"), (context) => context.redirect(route("/settings/sites"), 303));

  app.get(route("/settings/sites"), async (context) => {
    try {
      const access = await browserAccess(context); if (access instanceof Response) return access;
      const { shell, snapshot, themes } = await baseData(access);
      const created = snapshot.publications.find(({ publicationId }) => publicationId === context.req.query("created"));
      return context.html(sitesPage({ basePath: dependencies.basePath, shell, snapshot, themes, csrfToken: access.csrfToken, publicationLimit: dependencies.publicationLimit, reason: context.req.query("reason"), updated: context.req.query("updated"), created }));
    } catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.get(route("/settings/sites/home"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); return context.html(homePage({ basePath: dependencies.basePath, ...data, csrfToken: access.csrfToken, saved: context.req.query("saved") === "1" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.post(route("/settings/sites/home"), async (context) => {
    let body: Record<string, unknown> = {};
    let mutation: Awaited<ReturnType<typeof browserMutation>>;
    try { mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; body = mutation.body; await dependencies.service.updateHome(mutation.access.tenant, { name: body.name, themeId: typeof body.themeMode === "string" ? body.themeMode.replace(/^override:/, "") : body.themeMode }); return context.redirect(`${route("/settings/sites/home")}?saved=1`, 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); return context.html(homePage({ basePath: dependencies.basePath, ...data, csrfToken: access.csrfToken, name: typeof body.name === "string" ? body.name : undefined, themeId: typeof body.themeMode === "string" ? body.themeMode.replace(/^override:/, "") : undefined, error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });

  app.get(route("/settings/sites/new"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); if (data.snapshot.publications.length >= dependencies.publicationLimit) return context.html(publicationLimitPage({ basePath: dependencies.basePath, shell: data.shell, publicationLimit: dependencies.publicationLimit }), 409); return context.html(publicationFormPage({ basePath: dependencies.basePath, shell: data.shell, themes: data.themes, csrfToken: access.csrfToken, mode: "new" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.post(route("/settings/sites/new"), async (context) => {
    let body: Record<string, unknown> = {};
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; body = mutation.body; await dependencies.service.createPublication(mutation.access.tenant, { publicationId: body.publicationId, name: body.name, theme: publicationTheme(body) }); return context.redirect(`${route("/settings/sites")}?created=${encodeURIComponent(String(body.publicationId))}`, 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); return context.html(publicationFormPage({ basePath: dependencies.basePath, shell: data.shell, themes: data.themes, csrfToken: access.csrfToken, mode: "new", name: typeof body.name === "string" ? body.name : "", publicationId: typeof body.publicationId === "string" ? body.publicationId : "", theme: publicationTheme(body), error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });

  app.get(route("/settings/sites/:publicationId"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); const publication = data.snapshot.publications.find(({ publicationId }) => publicationId === context.req.param("publicationId")); if (!publication) return context.text("页面不存在。", 404); return context.html(publicationFormPage({ basePath: dependencies.basePath, shell: data.shell, themes: data.themes, csrfToken: access.csrfToken, mode: "edit", publication, saved: context.req.query("saved") === "1" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.post(route("/settings/sites/:publicationId"), async (context) => {
    let body: Record<string, unknown> = {};
    const targetId = context.req.param("publicationId") ?? "";
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; body = mutation.body; await dependencies.service.updatePublication(mutation.access.tenant, targetId, { name: body.name, theme: publicationTheme(body) }); return context.redirect(`${route(`/settings/sites/${encodeURIComponent(targetId)}`)}?saved=1`, 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); const publication = data.snapshot.publications.find(({ publicationId }) => publicationId === context.req.param("publicationId")); if (!publication) return context.text("页面不存在。", 404); return context.html(publicationFormPage({ basePath: dependencies.basePath, shell: data.shell, themes: data.themes, csrfToken: access.csrfToken, mode: "edit", publication, name: typeof body.name === "string" ? body.name : publication.name, theme: publicationTheme(body), error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });

  app.post(route("/settings/sites/:publicationId/move"), async (context) => {
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; const publicationId = context.req.param("publicationId") ?? ""; await dependencies.service.movePublication(mutation.access.tenant, publicationId, mutation.body.direction); return context.redirect(`${route("/settings/sites")}?updated=moved#site-${encodeURIComponent(publicationId)}`, 303); }
    catch (error) { const safe = formError(error); return context.text(safe.message, safe.status); }
  });

  app.get(route("/settings/sites/:publicationId/status/disable"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); const publication = data.snapshot.publications.find((item) => item.publicationId === context.req.param("publicationId") && item.status === "active"); if (!publication) return context.text("页面不存在。", 404); return context.html(renderConfirmPage({ basePath: dependencies.basePath, shell: data.shell, title: `停用 ${publication.name}？`, description: "Agent 的新写入会被拒绝；已有正式日报仍可从原地址阅读。至少需要保留一个启用中的日报站点。", action: route(`/settings/sites/${encodeURIComponent(publication.publicationId)}/status/disable`), csrfToken: access.csrfToken, submitLabel: "确认停用", cancelPath: `/settings/sites/${encodeURIComponent(publication.publicationId)}` })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  for (const [suffix, status] of [["disable", "inactive"], ["restore", "active"]] as const) {
    app.post(route(`/settings/sites/:publicationId/status/${suffix}`), async (context) => {
      try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; const publicationId = context.req.param("publicationId") ?? ""; await dependencies.service.setPublicationStatus(mutation.access.tenant, publicationId, status); return context.redirect(`${route("/settings/sites")}?updated=${status === "active" ? "restored" : "disabled"}#site-${encodeURIComponent(publicationId)}`, 303); }
      catch (error) { const safe = formError(error); return context.text(safe.message, safe.status); }
    });
  }

  app.get(route("/settings/sites/todo/disable"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); if (!data.snapshot.todo.enabled) return context.redirect(`${route("/settings/sites")}#personal-todo`, 303); return context.html(renderConfirmPage({ basePath: dependencies.basePath, shell: data.shell, title: "关闭 Personal Todo？", description: "关闭后 Agent 的新写入会失败，Todo 页面停止展示；已有正式内容会完整保留，再次启用后恢复。", action: route("/settings/sites/todo/disable"), csrfToken: access.csrfToken, submitLabel: "确认关闭", cancelPath: "/settings/sites#personal-todo", cancelLabel: "保留并返回" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  for (const [suffix, enabled] of [["enable", true], ["disable", false]] as const) {
    app.post(route(`/settings/sites/todo/${suffix}`), async (context) => {
      try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; await dependencies.service.setTodoEnabled(mutation.access.tenant, enabled); return context.redirect(enabled ? route("/todo/") : `${route("/settings/sites")}?updated=todo-disabled#personal-todo`, 303); }
      catch (error) { const safe = formError(error); return context.text(safe.message, safe.status); }
    });
  }

  app.get(route("/settings/themes"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const [shell, themes] = await Promise.all([dependencies.privateReading.readShell(access.tenant), dependencies.themes.list(access.tenant)]); return context.html(catalogPage({ basePath: dependencies.basePath, shell, themes })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.get(route("/settings/account"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const [shell, profile] = await Promise.all([dependencies.privateReading.readShell(access.tenant), dependencies.profiles.read(access.userId)]); if (!profile) return context.text("页面不存在。", 404); return context.html(renderAccountSettingsPage({ basePath: dependencies.basePath, shell, csrfToken: access.csrfToken, profile, saved: context.req.query("saved") === "1" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.post(route("/settings/account/nickname"), async (context) => {
    let nickname: unknown;
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; nickname = mutation.body.nickname; await dependencies.profiles.setNickname(mutation.access.userId, nickname); return context.redirect(`${route("/settings/account")}?saved=1`, 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const [shell, profile] = await Promise.all([dependencies.privateReading.readShell(access.tenant), dependencies.profiles.read(access.userId)]); if (!profile) return context.text("页面不存在。", 404); return context.html(renderAccountSettingsPage({ basePath: dependencies.basePath, shell, csrfToken: access.csrfToken, profile, nickname: typeof nickname === "string" ? nickname : "", error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });

  app.post(route("/onboarding/nickname"), async (context) => {
    let nickname: unknown;
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; nickname = mutation.body.nickname; await dependencies.profiles.setNickname(mutation.access.userId, nickname); return context.redirect(route("/onboarding"), 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const shell = await dependencies.privateReading.readShell(access.tenant); return context.html(renderNicknameOnboardingPage({ basePath: dependencies.basePath, shell, csrfToken: access.csrfToken, nickname: typeof nickname === "string" ? nickname : "", error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });
}
