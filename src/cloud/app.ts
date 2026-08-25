import { Hono } from "hono";

export interface CloudAppDependencies {
  basePath: string;
  readinessCheck: () => Promise<void>;
}

export function createCloudApp(dependencies: CloudAppDependencies): Hono {
  const app = new Hono();
  const route = (pathname: string) => `${dependencies.basePath}${pathname}`;

  app.use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
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

  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError((_error, context) => context.json({ error: "internal_error" }, 500));
  return app;
}
