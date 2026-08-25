import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { CloudRuntimeConfig } from "../../cloud/config.js";
import {
  FakeMailAdapter,
  TencentSesMailAdapter,
  type LoginMailAdapter,
} from "../../adapters/mail/mail.js";
import {
  PostgresLoginRateLimiter,
  type LoginDeliveryReservation,
} from "../../adapters/postgres/login-rate-limit.js";
import type { PostgresPool } from "../../adapters/postgres/pool.js";
import { IdentityPublicError, normalizeEmail } from "./security.js";

interface DeliveryContext {
  reservation: LoginDeliveryReservation;
  completed: boolean;
  deliveryFailed: boolean;
}

function joinPath(basePath: string, pathname: string): string {
  return `${basePath}${pathname}`;
}

function createMailAdapter(config: CloudRuntimeConfig): LoginMailAdapter {
  if (config.identity.mailMode === "fake") return new FakeMailAdapter();
  if (!config.identity.ses) throw new Error("SES mail mode requires SES configuration");
  return new TencentSesMailAdapter(config.identity.ses);
}

function sanitizeAuthResponse(response: Response): Response {
  if (response.ok) return response;
  const status = response.status === 429 ? 429 : response.status >= 500 ? 503 : response.status;
  const code = status === 429 ? "rate_limited" : status === 503 ? "service_unavailable" : "request_failed";
  return Response.json({ error: { code } }, { status });
}

function isStateChangingRequest(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function createIdentityService(options: {
  config: CloudRuntimeConfig;
  authPool: PostgresPool;
  appPool: PostgresPool;
  mailAdapter?: LoginMailAdapter;
}) {
  const { config } = options;
  const mailAdapter = options.mailAdapter ?? createMailAdapter(config);
  const rateLimiter = new PostgresLoginRateLimiter(options.appPool, {
    digestSecret: config.identity.digestSecret,
    limits: config.product.limits,
  });
  const deliveryContext = new AsyncLocalStorage<DeliveryContext>();
  const authBasePath = joinPath(config.basePath, "/api/auth");
  const sendOtpPath = joinPath(authBasePath, "/email-otp/send-verification-otp");

  const auth = betterAuth({
    appName: "DailyNews",
    baseURL: config.origin,
    basePath: authBasePath,
    secret: config.identity.authSecret,
    database: options.authPool,
    logger: { disabled: true },
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: config.product.identity.sessionExpiresInDays * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
    },
    advanced: {
      useSecureCookies: true,
      trustedProxyHeaders: false,
      ipAddress: { ipAddressHeaders: ["x-dailynews-client-ip"] },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: config.basePath || "/",
      },
    },
    plugins: [
      emailOTP({
        otpLength: config.product.identity.otpLength,
        expiresIn: config.product.identity.otpExpiresInSeconds,
        allowedAttempts: config.product.identity.otpAllowedAttempts,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        disableSignUp: false,
        rateLimit: { window: 60, max: 100 },
        async sendVerificationOTP({ email, otp, type }) {
          const context = deliveryContext.getStore();
          if (!context || type !== "sign-in") throw new Error("unreserved email delivery");
          try {
            const result = await mailAdapter.send({
              email,
              otp,
              expiresInMinutes: Math.ceil(config.product.identity.otpExpiresInSeconds / 60),
            });
            await rateLimiter.complete(context.reservation, { status: "sent", ...result });
            context.completed = true;
          } catch (error) {
            context.deliveryFailed = true;
            if (!context.completed) {
              await rateLimiter.complete(context.reservation, { status: "failed" });
              context.completed = true;
            }
            throw error;
          }
        },
      }),
    ],
  });

  async function handle(request: Request, clientIp: string): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("x-dailynews-client-ip", clientIp);
    if (isStateChangingRequest(request.method) && request.headers.get("origin") !== config.origin) {
      return Response.json({ error: { code: "request_failed" } }, { status: 403 });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== sendOtpPath) {
      return auth.handler(new Request(request, { headers }));
    }

    let reservation: LoginDeliveryReservation | undefined;
    let context: DeliveryContext | undefined;
    try {
      const body = await request.clone().json() as { email?: unknown; type?: unknown };
      if (body.type !== "sign-in") throw new IdentityPublicError(400, "request_failed");
      const email = normalizeEmail(body.email);
      reservation = await rateLimiter.reserve({ email, ip: clientIp });
      context = { reservation, completed: false, deliveryFailed: false };
      headers.set("content-type", "application/json");
      const normalizedRequest = new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, type: "sign-in" }),
      });
      const response = await deliveryContext.run(context, () => auth.handler(normalizedRequest));
      if (!context.completed) {
        await rateLimiter.complete(reservation, { status: "failed" });
        context.completed = true;
      }
      if (context.deliveryFailed) {
        return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
      }
      return sanitizeAuthResponse(response);
    } catch (error) {
      if (reservation && context && !context.completed) {
        await rateLimiter.complete(reservation, { status: "failed" }).catch(() => {});
        context.completed = true;
      }
      if (error instanceof IdentityPublicError) {
        return Response.json({ error: { code: error.code } }, { status: error.status });
      }
      return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
    }
  }

  async function getSession(request: Request, clientIp: string) {
    const headers = new Headers(request.headers);
    headers.set("x-dailynews-client-ip", clientIp);
    return auth.api.getSession({ headers });
  }

  return {
    auth,
    authBasePath,
    handle,
    getSession,
    mailAdapter,
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
