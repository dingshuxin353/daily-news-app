import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import type { CloudFileConfig } from "./config.js";
import type { IdentityService } from "../modules/identity/auth.js";
import { normalizeEmail, resolveTrustedClientIp } from "../modules/identity/security.js";
import type { AgentCredentialService } from "../modules/agent-access/credential-service.js";
import type { PostgresTenancyStore } from "../adapters/postgres/tenancy.js";
import { renderLoginPage, renderSpacePage } from "../web/cloud-pages.js";
import { registerAgentSettingsRoutes } from "../web/agent-settings.js";
import { resolveTrustedExternalOrigin } from "../web/settings-security.js";

export interface CloudAppDependencies {
  basePath: string;
  readinessCheck: () => Promise<void>;
  identity?: IdentityService;
  tenancy?: PostgresTenancyStore;
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
}

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cloudAssets = {
  "cloud.css": new URL("src/web/cloud.css", `file://${projectRoot}/`),
  "tokens.css": new URL("tokens.css", `file://${projectRoot}/`),
  "cloud-auth.js": new URL("src/web/cloud-auth.js", `file://${projectRoot}/`),
} as const;

function resolveNodeClientIp(context: Context): string {
  let remoteAddress: string | undefined;
  try {
    remoteAddress = getConnInfo(context).remote.address;
  } catch {
    remoteAddress = "127.0.0.1";
  }
  return resolveTrustedClientIp({
    remoteAddress,
    forwardedAddress: context.req.header("x-dailynews-client-ip"),
  });
}

function resolveNodeRequestOrigin(context: Context, configuredOrigin: string): string | null {
  let remoteAddress: string | undefined;
  let requestHost: string | undefined;
  let transportProtocol: "http" | "https";
  try {
    remoteAddress = getConnInfo(context).remote.address;
    const environment = context.env as {
      server?: { incoming?: { socket?: { encrypted?: boolean } } };
      incoming?: { socket?: { encrypted?: boolean } };
    };
    const incoming = environment.server?.incoming ?? environment.incoming;
    requestHost = context.req.header("host");
    transportProtocol = incoming?.socket?.encrypted ? "https" : "http";
  } catch {
    const requestUrl = new URL(context.req.url);
    remoteAddress = "127.0.0.1";
    requestHost = requestUrl.host;
    transportProtocol = requestUrl.protocol === "https:" ? "https" : "http";
  }
  return resolveTrustedExternalOrigin({
    requestUrl: context.req.url,
    requestHost,
    transportProtocol,
    configuredOrigin,
    remoteAddress,
    forwardedProto: context.req.header("x-forwarded-proto"),
  });
}

function privateResponseHeaders(context: Context): void {
  context.header("Cache-Control", "private, no-store");
  context.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("X-Robots-Tag", "noindex, nofollow");
}

export function createCloudApp(dependencies: CloudAppDependencies): Hono {
  const app = new Hono();
  const route = (pathname: string) => `${dependencies.basePath}${pathname}`;

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

  if (dependencies.identity && dependencies.tenancy && dependencies.defaults) {
    const identity = dependencies.identity;
    const tenancy = dependencies.tenancy;
    const defaults = dependencies.defaults;
    const clientIp = dependencies.clientIpResolver ?? resolveNodeClientIp;

    app.get(route("/assets/:name"), async (context) => {
      const name = context.req.param("name") as keyof typeof cloudAssets;
      const asset = cloudAssets[name];
      if (!asset) return context.json({ error: "not_found" }, 404);
      try {
        const content = await readFile(asset, "utf8");
        const contentType = name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
        return context.body(content, 200, { "Content-Type": contentType });
      } catch {
        return context.json({ error: "not_found" }, 404);
      }
    });

    app.get(route("/login"), async (context) => {
      try {
        const session = await identity.getSession(context.req.raw, clientIp(context));
        if (session) return context.redirect(route("/"), 303);
        return context.html(renderLoginPage(dependencies.basePath));
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    });

    app.all(route("/api/auth/*"), (context) => identity.handle(context.req.raw, clientIp(context)));

    app.get(route("/"), async (context) => {
      try {
        const session = await identity.getSession(context.req.raw, clientIp(context));
        if (!session) return context.redirect(route("/login"), 303);
        const tenant = await tenancy.ensureSpaceForUser(session.user.id, defaults);
        if (dependencies.agentSettings) {
          await dependencies.agentSettings.service.ensureBootstrapPairing(
            tenant,
            `req_${randomUUID().replaceAll("-", "")}`,
            dependencies.agentSettings.digestActor("session", `${session.session.id}:${session.user.id}`),
          );
        }
        const repository = tenancy.forTenant(tenant);
        const [home, publications, todo, themes] = await Promise.all([
          repository.getHomeProfile(),
          repository.listPublications(),
          repository.getTodoProfile(),
          repository.listThemeSelections(),
        ]);
        const publication = publications.find((item) => item.isDefault);
        const homeTheme = themes.find((item) => item.targetType === "home");
        if (!home || !publication || !todo || !homeTheme?.themeId) {
          return context.text("服务暂时不可用，请稍后重试。", 503);
        }
        return context.html(renderSpacePage({
          basePath: dependencies.basePath,
          spaceName: home.displayName,
          publicationName: publication.displayName,
          publicationId: publication.publicationId,
          todoEnabled: todo.enabled,
          themeName: homeTheme.themeId,
        }));
      } catch {
        return context.text("服务暂时不可用，请稍后重试。", 503);
      }
    });

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
        tenancy,
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
