import { randomBytes } from "node:crypto";
import { type Context, type Hono } from "hono";
import type { IdentityService } from "../modules/identity/auth.js";
import { ProfileError, type UserProfileService } from "../modules/identity/profile-service.js";
import type { PrivateReadingService, ReadingShell } from "../modules/private-reading/service.js";
import {
  SiteManagementError,
  type SiteManagementService,
  type SiteManagementSnapshot,
} from "../modules/site-management/service.js";
import type { BrowserTheme, SiteThemeCatalogService } from "../modules/site-management/theme-catalog.js";
import type { PostgresTenancyStore, TenantContext } from "../adapters/postgres/tenancy.js";
import type { CloudFileConfig } from "../cloud/config.js";
import { AgentAccessError } from "../modules/agent-access/credential-service.js";
import { assertBrowserMutation, createSettingsCsrfToken, readSettingsBody } from "./settings-security.js";
import {
  renderAccountSettingsPage,
  renderHomeSettingsPage,
  renderNicknameOnboardingPage,
  renderPublicationFormPage,
  renderPublicationLimitPage,
  renderSettingsConfirmPage,
  renderSitesPage,
  renderThemeCatalogPage,
} from "./react/render.js";

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

function formError(error: unknown): { message: string; status: 400 | 403 | 404 | 409 | 503 } {
  if (error instanceof AgentAccessError) {
    return { message: error.message, status: error.status === 403 ? 403 : 400 };
  }
  if (error instanceof ProfileError) {
    if (error.code === "PROFILE_INPUT_INVALID") return { message: "昵称须为 1–24 个可见字符。", status: 400 };
    if (error.code === "PROFILE_TARGET_NOT_FOUND") return { message: "找不到这个账户。", status: 404 };
    return { message: "账户设置未能保存，请稍后重试。", status: 503 };
  }
  if (error instanceof SiteManagementError) {
    const messages: Partial<Record<typeof error.code, string>> = {
      SITE_INPUT_INVALID: "请检查名称、私有地址和主题后再试。",
      SITE_NAME_CONFLICT: "这个名称已被使用，请换一个。",
      SITE_ID_CONFLICT: "这个私有地址已被使用，请换一个。",
      SITE_LIMIT_REACHED: "已达到日报数量上限；停用的日报也会计入。",
      SITE_TARGET_NOT_FOUND: "找不到这个日报站点。",
      SITE_LAST_ACTIVE: "至少保留一个启用中的日报站点。",
      SITE_THEME_NOT_FOUND: "所选主题已经不可用，请重新选择。",
      SITE_STORAGE_FAILED: "设置未能保存，请稍后重试。",
    };
    const status = error.code === "SITE_TARGET_NOT_FOUND" ? 404
      : error.code === "SITE_INPUT_INVALID" ? 400
      : error.code === "SITE_STORAGE_FAILED" ? 503
      : 409;
    return { message: messages[error.code] ?? "设置未能保存，请稍后重试。", status };
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

export function newPublicationId(existingIds: Iterable<string>): string {
  const existing = new Set(existingIds);
  let publicationId: string;
  do publicationId = `daily-${randomBytes(3).toString("hex")}`;
  while (existing.has(publicationId));
  return publicationId;
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
      return context.html(renderSitesPage({ basePath: dependencies.basePath, shell, snapshot, themes, csrfToken: access.csrfToken, publicationLimit: dependencies.publicationLimit, reason: context.req.query("reason"), updated: context.req.query("updated"), created }));
    } catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.get(route("/settings/sites/home"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); return context.html(renderHomeSettingsPage({ basePath: dependencies.basePath, ...data, csrfToken: access.csrfToken, saved: context.req.query("saved") === "1" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.post(route("/settings/sites/home"), async (context) => {
    let body: Record<string, unknown> = {};
    let mutation: Awaited<ReturnType<typeof browserMutation>>;
    try { mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; body = mutation.body; await dependencies.service.updateHome(mutation.access.tenant, { name: body.name, themeId: typeof body.themeMode === "string" ? body.themeMode.replace(/^override:/, "") : body.themeMode }); return context.redirect(`${route("/settings/sites/home")}?saved=1`, 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); return context.html(renderHomeSettingsPage({ basePath: dependencies.basePath, ...data, csrfToken: access.csrfToken, name: typeof body.name === "string" ? body.name : undefined, themeId: typeof body.themeMode === "string" ? body.themeMode.replace(/^override:/, "") : undefined, error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });

  app.get(route("/settings/sites/new"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); if (data.snapshot.publications.length >= dependencies.publicationLimit) return context.html(renderPublicationLimitPage({ basePath: dependencies.basePath, shell: data.shell, publicationLimit: dependencies.publicationLimit }), 409); return context.html(renderPublicationFormPage({ basePath: dependencies.basePath, shell: data.shell, themes: data.themes, csrfToken: access.csrfToken, mode: "new", publicationId: newPublicationId(data.snapshot.publications.map(({ publicationId }) => publicationId)) })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.post(route("/settings/sites/new"), async (context) => {
    let body: Record<string, unknown> = {};
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; body = mutation.body; await dependencies.service.createPublication(mutation.access.tenant, { publicationId: body.publicationId, name: body.name, theme: publicationTheme(body) }); return context.redirect(`${route("/settings/sites")}?created=${encodeURIComponent(String(body.publicationId))}`, 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); return context.html(renderPublicationFormPage({ basePath: dependencies.basePath, shell: data.shell, themes: data.themes, csrfToken: access.csrfToken, mode: "new", name: typeof body.name === "string" ? body.name : "", publicationId: typeof body.publicationId === "string" ? body.publicationId : "", theme: publicationTheme(body), error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });

  app.get(route("/settings/sites/:publicationId"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); const publication = data.snapshot.publications.find(({ publicationId }) => publicationId === context.req.param("publicationId")); if (!publication) return context.text("找不到这个页面。", 404); return context.html(renderPublicationFormPage({ basePath: dependencies.basePath, shell: data.shell, themes: data.themes, csrfToken: access.csrfToken, mode: "edit", publication, saved: context.req.query("saved") === "1" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.post(route("/settings/sites/:publicationId"), async (context) => {
    let body: Record<string, unknown> = {};
    const targetId = context.req.param("publicationId") ?? "";
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; body = mutation.body; await dependencies.service.updatePublication(mutation.access.tenant, targetId, { name: body.name, theme: publicationTheme(body) }); return context.redirect(`${route(`/settings/sites/${encodeURIComponent(targetId)}`)}?saved=1`, 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); const publication = data.snapshot.publications.find(({ publicationId }) => publicationId === context.req.param("publicationId")); if (!publication) return context.text("找不到这个页面。", 404); return context.html(renderPublicationFormPage({ basePath: dependencies.basePath, shell: data.shell, themes: data.themes, csrfToken: access.csrfToken, mode: "edit", publication, name: typeof body.name === "string" ? body.name : publication.name, theme: publicationTheme(body), error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });

  app.post(route("/settings/sites/:publicationId/move"), async (context) => {
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; const publicationId = context.req.param("publicationId") ?? ""; await dependencies.service.movePublication(mutation.access.tenant, publicationId, mutation.body.direction); return context.redirect(`${route("/settings/sites")}?updated=moved#site-${encodeURIComponent(publicationId)}`, 303); }
    catch (error) { const safe = formError(error); return context.text(safe.message, safe.status); }
  });

  app.get(route("/settings/sites/:publicationId/status/disable"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); const publication = data.snapshot.publications.find((item) => item.publicationId === context.req.param("publicationId") && item.status === "active"); if (!publication) return context.text("找不到这个页面。", 404); return context.html(renderSettingsConfirmPage({ basePath: dependencies.basePath, shell: data.shell, title: `停用 ${publication.name}？`, description: "停用后，Agent 不能再写入；已有日报仍可从原地址阅读。至少保留一个启用中的日报站点。", action: route(`/settings/sites/${encodeURIComponent(publication.publicationId)}/status/disable`), csrfToken: access.csrfToken, submitLabel: "确认停用", cancelPath: `/settings/sites/${encodeURIComponent(publication.publicationId)}` })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  for (const [suffix, status] of [["disable", "inactive"], ["restore", "active"]] as const) {
    app.post(route(`/settings/sites/:publicationId/status/${suffix}`), async (context) => {
      try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; const publicationId = context.req.param("publicationId") ?? ""; await dependencies.service.setPublicationStatus(mutation.access.tenant, publicationId, status); return context.redirect(`${route("/settings/sites")}?updated=${status === "active" ? "restored" : "disabled"}#site-${encodeURIComponent(publicationId)}`, 303); }
      catch (error) { const safe = formError(error); return context.text(safe.message, safe.status); }
    });
  }

  app.get(route("/settings/sites/todo/disable"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const data = await baseData(access); if (!data.snapshot.todo.enabled) return context.redirect(`${route("/settings/sites")}#personal-todo`, 303); return context.html(renderSettingsConfirmPage({ basePath: dependencies.basePath, shell: data.shell, title: "关闭 Personal Todo？", description: "关闭后 Agent 不能再写入，Todo 页面也会隐藏；已有任务会保留，重新开启后恢复。", action: route("/settings/sites/todo/disable"), csrfToken: access.csrfToken, submitLabel: "确认关闭", cancelPath: "/settings/sites#personal-todo", cancelLabel: "保留并返回" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  for (const [suffix, enabled] of [["enable", true], ["disable", false]] as const) {
    app.post(route(`/settings/sites/todo/${suffix}`), async (context) => {
      try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; await dependencies.service.setTodoEnabled(mutation.access.tenant, enabled); return context.redirect(enabled ? route("/todo/") : `${route("/settings/sites")}?updated=todo-disabled#personal-todo`, 303); }
      catch (error) { const safe = formError(error); return context.text(safe.message, safe.status); }
    });
  }

  app.get(route("/settings/themes"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const [shell, themes] = await Promise.all([dependencies.privateReading.readShell(access.tenant), dependencies.themes.list(access.tenant)]); return context.html(renderThemeCatalogPage({ basePath: dependencies.basePath, shell, themes })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.get(route("/settings/account"), async (context) => {
    try { const access = await browserAccess(context); if (access instanceof Response) return access; const [shell, profile] = await Promise.all([dependencies.privateReading.readShell(access.tenant), dependencies.profiles.read(access.userId)]); if (!profile) return context.text("找不到这个页面。", 404); return context.html(renderAccountSettingsPage({ basePath: dependencies.basePath, shell, csrfToken: access.csrfToken, profile, saved: context.req.query("saved") === "1" })); }
    catch { return context.text("服务暂时不可用，请稍后重试。", 503); }
  });

  app.post(route("/settings/account/nickname"), async (context) => {
    let nickname: unknown;
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; nickname = mutation.body.nickname; await dependencies.profiles.setNickname(mutation.access.userId, nickname); return context.redirect(`${route("/settings/account")}?saved=1`, 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const [shell, profile] = await Promise.all([dependencies.privateReading.readShell(access.tenant), dependencies.profiles.read(access.userId)]); if (!profile) return context.text("找不到这个页面。", 404); return context.html(renderAccountSettingsPage({ basePath: dependencies.basePath, shell, csrfToken: access.csrfToken, profile, nickname: typeof nickname === "string" ? nickname : "", error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });

  app.post(route("/onboarding/nickname"), async (context) => {
    let nickname: unknown;
    try { const mutation = await browserMutation(context); if (mutation instanceof Response) return mutation; nickname = mutation.body.nickname; await dependencies.profiles.setNickname(mutation.access.userId, nickname); return context.redirect(route("/onboarding"), 303); }
    catch (error) { const safe = formError(error); if (safe.status === 403) return context.text(safe.message, 403); try { const access = await browserAccess(context); if (access instanceof Response) return access; const shell = await dependencies.privateReading.readShell(access.tenant); return context.html(renderNicknameOnboardingPage({ basePath: dependencies.basePath, shell, csrfToken: access.csrfToken, nickname: typeof nickname === "string" ? nickname : "", error: safe.message }), safe.status); } catch { return context.text(safe.message, safe.status); } }
  });
}
