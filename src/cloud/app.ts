import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import type { CloudFileConfig } from "./config.js";
import type { IdentityService } from "../modules/identity/auth.js";
import { normalizeEmail, resolveTrustedClientIp } from "../modules/identity/security.js";
import type { AgentCredentialService } from "../modules/agent-access/credential-service.js";
import type { AgentRequestAuthenticator } from "./agent-context.js";
import type { AgentOperationsService } from "../modules/agent-access/operations.js";
import type { PrivateReadingService } from "../modules/private-reading/service.js";
import type { SiteManagementService } from "../modules/site-management/service.js";
import type { SiteThemeCatalogService } from "../modules/site-management/theme-catalog.js";
import type { UserProfileService } from "../modules/identity/profile-service.js";
import type { PostgresTenancyStore } from "../adapters/postgres/tenancy.js";
import { renderSpacePage } from "../web/cloud-pages.js";
import {
  renderDailyPage,
  renderHomePage,
  renderLoginPage,
  renderNicknameOnboardingPage,
  renderOnboardingPage,
  renderPublicationsPage,
  renderPublicPage,
  renderTodoPage,
} from "../web/private-pages.js";
import { registerAgentSettingsRoutes } from "../web/agent-settings.js";
import { renderAgentSetupMarkdown } from "../web/agent-setup.js";
import { registerSiteSettingsRoutes } from "../web/site-settings.js";
import { createSettingsCsrfToken, resolveTrustedExternalOrigin } from "../web/settings-security.js";
import { registerAgentApiRoutes } from "../protocols/http-api/routes.js";
import { registerAgentMcpRoute } from "../protocols/mcp/routes.js";

export interface CloudAppDependencies {
  basePath: string;
  readinessCheck: () => Promise<void>;
  identity?: IdentityService;
  tenancy?: PostgresTenancyStore;
  privateReading?: PrivateReadingService;
  defaults?: CloudFileConfig["defaults"];
  clientIpResolver?: (context: Context) => string;
  testMailReader?: { latestFor(email: string): { otp: string } | null };
  agentSettings?: {
    origin: string;
    csrfSecret: string;
    service: AgentCredentialService;
    digestActor: (purpose: "session" | "ip", value: string) => string;
    apiBaseUrl: string;
    mcpUrl: string;
    activeCredentialLimit: number;
    requestBodyLimitBytes: number;
  };
  siteSettings?: {
    origin: string;
    csrfSecret: string;
    service: SiteManagementService;
    themes: SiteThemeCatalogService;
    profiles: UserProfileService;
    publicationLimit: number;
    requestBodyLimitBytes: number;
  };
  agentApi?: {
    authenticator: AgentRequestAuthenticator;
    operations: AgentOperationsService;
    requestBodyLimitBytes: number;
  };
  agentMcp?: {
    origin: string;
    authenticator: AgentRequestAuthenticator;
    operations: AgentOperationsService;
    requestBodyLimitBytes: number;
    dailyItemLimit: number;
    todoOperationLimit: number;
    requestOriginResolver?: (context: Context) => string | null;
  };
}

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const agentSetupSource = new URL("docs/AGENT_SETUP.md", `file://${projectRoot}/`);
const agentSetupContentSource = new URL("docs/agent-setup/content.md", `file://${projectRoot}/`);
const agentSetupTodoSource = new URL("docs/agent-setup/todo.md", `file://${projectRoot}/`);
const agentSetupThemeSource = new URL("docs/agent-setup/theme.md", `file://${projectRoot}/`);
const cloudAssets = {
  "cloud.css": { url: new URL("src/web/cloud.css", `file://${projectRoot}/`), contentType: "text/css; charset=utf-8", text: true },
  "tokens.css": { url: new URL("tokens.css", `file://${projectRoot}/`), contentType: "text/css; charset=utf-8", text: true },
  "cloud-auth.js": { url: new URL("src/web/cloud-auth.js", `file://${projectRoot}/`), contentType: "text/javascript; charset=utf-8", text: true },
  "private-pages.js": { url: new URL("src/web/private-pages.js", `file://${projectRoot}/`), contentType: "text/javascript; charset=utf-8", text: true },
  "private-newsroom.png": { url: new URL("src/web/assets/private-newsroom-transparent.png", `file://${projectRoot}/`), contentType: "image/png", text: false },
} as const;

const cloudThemeBridge = `
:root {
  --site-accent: var(--color-accent-default);
  --color-paper: var(--color-background);
  --color-paper-2: color-mix(in srgb, var(--color-background) 94%, var(--color-text));
  --color-ink: var(--color-text);
  --color-ink-soft: color-mix(in srgb, var(--color-text) 78%, var(--color-background));
  --color-accent-ink: color-mix(in srgb, var(--color-text) 88%, var(--color-background));
  --color-focus: color-mix(in srgb, var(--color-accent) 65%, var(--color-text));
  --font-display: var(--font-headline);
  --font-body: var(--font-ui);
}
`;

function safeReturnTo(raw: string | undefined, basePath: string): { path: string; label: string } | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(raw, "https://dailynews.invalid");
  } catch {
    return null;
  }
  const localPath = basePath && url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length) || "/"
    : url.pathname;
  if (localPath === "/home") return { path: `${basePath}/home`, label: "私人日报总览" };
  if (localPath === "/publications/") return { path: `${basePath}/publications/`, label: "我的日报" };
  if (localPath === "/todo/") {
    if (url.hash && !/^#todo-[a-f0-9]{8}$/.test(url.hash)) return null;
    return { path: `${basePath}/todo/${url.hash}`, label: "个人待办" };
  }
  if (/^\/p\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(localPath) && (!url.search || /^\?date=\d{4}-\d{2}-\d{2}$/.test(url.search))) {
    return { path: `${basePath}${localPath}${url.search}`, label: url.search ? `${url.search.slice(6)} 日报` : "私人日报" };
  }
  if (
    localPath === "/settings"
    || /^\/settings\/(?:sites(?:\/home|\/new|\/[a-z0-9]+(?:-[a-z0-9]+)*)?|themes|agent|account|advanced)$/.test(localPath)
    || localPath === "/onboarding"
  ) {
    return { path: `${basePath}${localPath}`, label: localPath === "/onboarding" ? "首次使用" : "编辑部设置" };
  }
  return null;
}

function resolveNodeClientIp(context: Context): string {
  let remoteAddress: string | undefined;
  try {
    remoteAddress = getConnInfo(context).remote.address;
  } catch {
    remoteAddress = "0.0.0.0";
  }
  return resolveTrustedClientIp({
    remoteAddress,
    forwardedAddress: context.req.header("x-dailynews-client-ip"),
  });
}

function resolveNodeRequestOrigin(context: Context, configuredOrigin: string): string | null {
  try {
    const remoteAddress = getConnInfo(context).remote.address;
    const environment = context.env as {
      server?: { incoming?: { socket?: { encrypted?: boolean } } };
      incoming?: { socket?: { encrypted?: boolean } };
    };
    const incoming = environment.server?.incoming ?? environment.incoming;
    if (!incoming?.socket) return null;
    return resolveTrustedExternalOrigin({
      requestUrl: context.req.url,
      requestHost: context.req.header("host"),
      transportProtocol: incoming.socket.encrypted ? "https" : "http",
      configuredOrigin,
      remoteAddress,
      forwardedProto: context.req.header("x-forwarded-proto"),
    });
  } catch {
    return null;
  }
}

function privateResponseHeaders(context: Context): void {
  context.header("Cache-Control", "private, no-store");
  context.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("X-Robots-Tag", "noindex, nofollow");
}

export function createCloudApp(dependencies: CloudAppDependencies): Hono {
  const app = new Hono();
  const route = (pathname: string) => `${dependencies.basePath}${pathname}`;
  const clientIp = dependencies.clientIpResolver ?? resolveNodeClientIp;

  app.use("*", async (context, next) => {
    await next();
    privateResponseHeaders(context);
  });

  app.get(route("/health/live"), (context) => context.json({ status: "ok" }, 200));
  app.get(route("/health/ready"), async (context) => {
    try {
      await dependencies.readinessCheck();
      return context.json({ status: "ready" }, 200);
    } catch {
      return context.json({ status: "unavailable" }, 503);
    }
  });

  if (dependencies.agentApi) {
    registerAgentApiRoutes(app, {
      basePath: dependencies.basePath,
      authenticator: dependencies.agentApi.authenticator,
      operations: dependencies.agentApi.operations,
      clientIpResolver: clientIp,
      requestBodyLimitBytes: dependencies.agentApi.requestBodyLimitBytes,
    });
  }

  if (dependencies.agentMcp) {
    registerAgentMcpRoute(app, {
      basePath: dependencies.basePath,
      origin: dependencies.agentMcp.origin,
      authenticator: dependencies.agentMcp.authenticator,
      operations: dependencies.agentMcp.operations,
      clientIpResolver: clientIp,
      requestOriginResolver: dependencies.agentMcp.requestOriginResolver
        ?? ((context) => resolveNodeRequestOrigin(context, dependencies.agentMcp!.origin)),
      requestBodyLimitBytes: dependencies.agentMcp.requestBodyLimitBytes,
      dailyItemLimit: dependencies.agentMcp.dailyItemLimit,
      todoOperationLimit: dependencies.agentMcp.todoOperationLimit,
    });
  }

  if (dependencies.agentSettings) {
    const serveAgentSetup = async (context: Context, source: URL) => {
      try {
        const markdown = renderAgentSetupMarkdown(
          await readFile(source, "utf8"),
          dependencies.agentSettings!.apiBaseUrl,
        );
        return context.body(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    };

    app.get(route("/agent-setup.md"), (context) => serveAgentSetup(context, agentSetupSource));
    app.get(route("/agent-setup/content.md"), (context) => serveAgentSetup(context, agentSetupContentSource));
    app.get(route("/agent-setup/todo.md"), (context) => serveAgentSetup(context, agentSetupTodoSource));
    app.get(route("/agent-setup/theme.md"), (context) => serveAgentSetup(context, agentSetupThemeSource));
  }

  if (dependencies.identity && dependencies.tenancy && dependencies.defaults) {
    const identity = dependencies.identity;
    const tenancy = dependencies.tenancy;
    const defaults = dependencies.defaults;

    app.get(route("/assets/:name"), async (context) => {
      const name = context.req.param("name") as keyof typeof cloudAssets;
      const asset = cloudAssets[name];
      if (!asset) return context.json({ error: "not_found" }, 404);
      try {
        const content = asset.text ? await readFile(asset.url, "utf8") : await readFile(asset.url);
        return context.body(content as any, 200, { "Content-Type": asset.contentType });
      } catch {
        return context.json({ error: "not_found" }, 404);
      }
    });

    app.get(route("/assets/themes/:themeId/:file"), async (context) => {
      const themeId = context.req.param("themeId") ?? "";
      const revision = /^([1-9]\d*)\.css$/.exec(context.req.param("file") ?? "")?.[1];
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(themeId) || !revision) {
        return context.json({ error: "not_found" }, 404);
      }
      try {
        const content = await readFile(new URL(`themes/compiled/${themeId}/${revision}.css`, `file://${projectRoot}/`), "utf8");
        return context.body(`${content}${cloudThemeBridge}`, 200, { "Content-Type": "text/css; charset=utf-8" });
      } catch {
        if (!dependencies.privateReading) return context.json({ error: "not_found" }, 404);
        const access = await privateAccess(context);
        if (!access) return context.json({ error: "not_found" }, 404);
        const content = await dependencies.privateReading.readThemeCss(access.tenant, themeId, Number(revision));
        return content
          ? context.body(`${content}${cloudThemeBridge}`, 200, { "Content-Type": "text/css; charset=utf-8" })
          : context.json({ error: "not_found" }, 404);
      }
    });

    app.get(route("/login"), async (context) => {
      try {
        const session = await identity.getSession(context.req.raw, clientIp(context));
        if (session) return context.redirect(route("/home"), 303);
        const target = safeReturnTo(context.req.query("returnTo"), dependencies.basePath);
        return context.html(renderLoginPage(dependencies.basePath, {
          returnTo: target?.path,
          returnLabel: target?.label,
        }));
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    });

    app.all(route("/api/auth/*"), (context) => identity.handle(context.req.raw, clientIp(context)));

    app.get(route("/"), async (context) => {
      try {
        const session = await identity.getSession(context.req.raw, clientIp(context));
        return context.html(renderPublicPage({ basePath: dependencies.basePath, signedIn: Boolean(session) }));
      } catch {
        return context.html(renderPublicPage({ basePath: dependencies.basePath, signedIn: false }));
      }
    });

    const privateAccess = async (context: Context) => {
      const session = await identity.getSession(context.req.raw, clientIp(context));
      if (!session) return null;
      const tenant = await tenancy.ensureSpaceForUser(session.user.id, defaults);
      return { session, tenant };
    };

    const requirePrivateAccess = async (context: Context) => {
      const access = await privateAccess(context);
      if (access) return access;
      const target = `${context.req.path}${new URL(context.req.url).search}`;
      const login = new URL(`${route("/login")}`, "https://dailynews.invalid");
      login.searchParams.set("returnTo", target);
      return context.redirect(`${login.pathname}${login.search}`, 303);
    };

    app.get(route("/post-login"), async (context) => {
      try {
        const session = await identity.getSession(context.req.raw, clientIp(context));
        if (!session) return context.redirect(route("/login"), 303);
        const existing = await tenancy.resolveTenantContextForUser(session.user.id);
        await tenancy.ensureSpaceForUser(session.user.id, defaults);
        const profile = dependencies.siteSettings
          ? await dependencies.siteSettings.profiles.read(session.user.id)
          : null;
        const target = safeReturnTo(context.req.query("returnTo"), dependencies.basePath);
        return context.redirect(existing && (!dependencies.siteSettings || profile?.complete)
          ? target?.path ?? route("/home")
          : route("/onboarding"), 303);
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    });

    app.get(route("/home"), async (context) => {
      try {
        const access = await requirePrivateAccess(context);
        if (access instanceof Response) return access;
        if (!dependencies.privateReading) {
          const repository = tenancy.forTenant(access.tenant);
          const [home, publications, todo, themes] = await Promise.all([repository.getHomeProfile(), repository.listPublications(), repository.getTodoProfile(), repository.listThemeSelections()]);
          const publication = publications.find((item) => item.isDefault);
          const homeTheme = themes.find((item) => item.targetType === "home");
          if (!home || !publication || !todo || !homeTheme?.themeId) throw new Error("bootstrap unavailable");
          return context.html(renderSpacePage({ basePath: dependencies.basePath, spaceName: home.displayName, publicationName: publication.displayName, publicationId: publication.publicationId, todoEnabled: todo.enabled, themeName: homeTheme.themeId }));
        }
        const reading = await dependencies.privateReading.readHome(access.tenant);
        return context.html(renderHomePage({
          basePath: dependencies.basePath,
          shell: reading.shell,
          daily: reading.daily,
          publications: reading.publications,
          todoProjection: reading.todoProjection,
        }));
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    });

    app.get(route("/publications/"), async (context) => {
      try {
        const access = await requirePrivateAccess(context);
        if (access instanceof Response) return access;
        if (!dependencies.privateReading) return context.text("服务暂时不可用，请稍后重试。", 503);
        const reading = await dependencies.privateReading.readPublicationDirectory(access.tenant);
        return context.html(renderPublicationsPage({
          basePath: dependencies.basePath,
          shell: reading.shell,
          publications: reading.publications,
        }));
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    });

    app.get(route("/p/:publicationId/"), async (context) => {
      try {
        const access = await requirePrivateAccess(context);
        if (access instanceof Response) return access;
        if (!dependencies.privateReading) return context.text("服务暂时不可用，请稍后重试。", 503);
        const publicationId = context.req.param("publicationId") ?? "";
        const readingShell = await dependencies.privateReading.readPublicationShell(access.tenant, publicationId);
        if (!readingShell) return context.text("页面不存在。", 404);
        const requestedDate = context.req.query("date");
        const result = await dependencies.privateReading.readDailyResult(access.tenant, publicationId, requestedDate);
        if (!result) return context.text("页面不存在。", 404);
        return context.html(renderDailyPage({
          basePath: dependencies.basePath,
          shell: readingShell,
          daily: result.daily,
          dates: result.dates,
          requestedDate,
        }), result.daily || !requestedDate ? 200 : 404);
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    });

    app.get(route("/todo/"), async (context) => {
      try {
        const access = await requirePrivateAccess(context);
        if (access instanceof Response) return access;
        if (!dependencies.privateReading) return context.text("服务暂时不可用，请稍后重试。", 503);
        const readingShell = await dependencies.privateReading.readShell(access.tenant);
        const todo = await dependencies.privateReading.readTodo(access.tenant);
        if (!todo.enabled || !todo.projection) return context.redirect(`${route("/settings/sites")}?reason=todo-disabled#personal-todo`, 303);
        return context.html(renderTodoPage({ basePath: dependencies.basePath, shell: readingShell, projection: todo.projection }));
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    });

    if (dependencies.agentSettings && dependencies.privateReading) {
      app.get(route("/onboarding"), async (context) => {
        try {
          const access = await requirePrivateAccess(context);
          if (access instanceof Response) return access;
          if (dependencies.siteSettings) {
            const profile = await dependencies.siteSettings.profiles.read(access.session.user.id);
            if (!profile?.complete) {
              const readingShell = await dependencies.privateReading!.readShell(access.tenant);
              return context.html(renderNicknameOnboardingPage({
                basePath: dependencies.basePath,
                shell: readingShell,
                csrfToken: createSettingsCsrfToken(dependencies.siteSettings.csrfSecret, access.session.session.id, access.session.user.id),
              }));
            }
          }
          const readingShell = await dependencies.privateReading!.readShell(access.tenant);
          return context.html(renderOnboardingPage({
            basePath: dependencies.basePath,
            shell: readingShell,
            csrfToken: createSettingsCsrfToken(dependencies.agentSettings!.csrfSecret, access.session.session.id, access.session.user.id),
            operationId: randomUUID(),
            setupUrl: `${dependencies.agentSettings!.origin}${route("/agent-setup.md")}`,
          }));
        } catch {
          return context.text("服务暂时不可用，请稍后重试。", 503);
        }
      });
    }

    if (dependencies.siteSettings && dependencies.privateReading) {
      registerSiteSettingsRoutes(app, {
        basePath: dependencies.basePath,
        origin: dependencies.siteSettings.origin,
        csrfSecret: dependencies.siteSettings.csrfSecret,
        identity,
        tenancy,
        privateReading: dependencies.privateReading,
        defaults,
        service: dependencies.siteSettings.service,
        themes: dependencies.siteSettings.themes,
        profiles: dependencies.siteSettings.profiles,
        publicationLimit: dependencies.siteSettings.publicationLimit,
        clientIpResolver: clientIp,
        requestOriginResolver: (context) => resolveNodeRequestOrigin(context, dependencies.siteSettings!.origin),
        requestBodyLimitBytes: dependencies.siteSettings.requestBodyLimitBytes,
      });
    }

    if (dependencies.agentSettings) {
      app.get(route("/settings/advanced/openapi.yaml"), async (context) => {
        try {
          const access = await requirePrivateAccess(context);
          if (access instanceof Response) return access;
          const content = await readFile(new URL("docs/openapi-v1.yaml", `file://${projectRoot}/`), "utf8");
          return context.body(content, 200, {
            "Content-Type": "application/yaml; charset=utf-8",
            "Content-Disposition": 'attachment; filename="dailynews-openapi-v1.yaml"',
          });
        } catch {
          return context.text("服务暂时不可用，请稍后重试。", 503);
        }
      });
    }

    if (dependencies.testMailReader) {
      app.get(route("/__test__/mail/latest"), (context) => {
        try {
          const email = normalizeEmail(context.req.query("email"));
          const message = dependencies.testMailReader?.latestFor(email);
          return message ? context.json({ otp: message.otp }) : context.json({ error: "not_found" }, 404);
        } catch {
          return context.json({ error: "not_found" }, 404);
        }
      });
    }

    if (dependencies.agentSettings) {
      registerAgentSettingsRoutes(app, {
        basePath: dependencies.basePath,
        origin: dependencies.agentSettings.origin,
        csrfSecret: dependencies.agentSettings.csrfSecret,
        identity,
        profiles: dependencies.siteSettings?.profiles,
        tenancy,
        privateReading: dependencies.privateReading,
        defaults,
        agentAccess: dependencies.agentSettings.service,
        clientIpResolver: clientIp,
        requestOriginResolver: (context) => resolveNodeRequestOrigin(context, dependencies.agentSettings!.origin),
        digestActor: dependencies.agentSettings.digestActor,
        apiBaseUrl: dependencies.agentSettings.apiBaseUrl,
        mcpUrl: dependencies.agentSettings.mcpUrl,
        activeCredentialLimit: dependencies.agentSettings.activeCredentialLimit,
        requestBodyLimitBytes: dependencies.agentSettings.requestBodyLimitBytes,
      });
    }
  }

  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError((_error, context) => context.json({ error: "internal_error" }, 500));
  return app;
}
