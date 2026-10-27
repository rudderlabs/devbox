import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type ApiController, type ApiEnv, errorBody } from "../controllers/api.controller";
import { logger } from "../logger";
import { API_BODY_LIMIT_BYTES } from "../requestLimits";
import type { ApiAuthService } from "../services/apiAuth.service";
import type { GithubStatus } from "../services/githubStatus.service";
import type { LinearStatus } from "../services/linearStatus.service";

// /api. Mounted by app.ts only when API_ENABLED=true.
// Order matters: the host check runs first (a disallowed host learns nothing,
// not even that auth exists), then the body cap, then auth.
export function createApiRoutes(
  controller: ApiController,
  auth: Pick<ApiAuthService, "authenticate">,
  opts: {
    authEnabled: boolean;
    allowedHosts: string[];
    linearStatus: () => Promise<LinearStatus>;
    githubStatus: () => GithubStatus;
  },
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.use("/api/*", async (c, next) => {
    if (opts.allowedHosts.length > 0) {
      const host = (c.req.header("host") ?? "").toLowerCase().replace(/:\d+$/, "");
      if (!opts.allowedHosts.includes(host)) return c.notFound();
    }
    await next();
  });

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT_BYTES,
      onError: (c) => c.json(errorBody("invalid_request", "Request body is too large"), 400),
    }),
  );

  app.use("/api/*", async (c, next) => {
    if (!opts.authEnabled) {
      c.set("principal", null);
      return next();
    }
    let principal: Awaited<ReturnType<typeof auth.authenticate>>;
    try {
      principal = await auth.authenticate(c.req.header("authorization"));
    } catch (err) {
      // Never log the header.
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error("api auth failed", { message: e.message, stack: e.stack });
      // Don't turn an outage into "your token is wrong".
      return c.json(errorBody("internal", "Internal error"), 500);
    }
    if (!principal) return c.json(errorBody("unauthorized", "Missing or invalid API token"), 401);
    c.set("principal", principal);
    await next();
  });

  app.post("/api/tasks", (c) => controller.createTask(c));
  app.get("/api/tasks", (c) => controller.listTasks(c));
  app.get("/api/tasks/:ref", (c) => controller.getTask(c));
  app.post("/api/tasks/:ref/messages", (c) => controller.sendMessage(c));
  app.post("/api/tasks/:ref/restart", (c) => controller.restartTask(c));
  app.get("/api/tasks/:ref/events/stream", (c) => controller.streamEvents(c));
  app.get("/api/tasks/:ref/events", (c) => controller.listEvents(c));
  app.get("/api/me", (c) => controller.me(c));
  app.get("/api/integrations/linear", async (c) => c.json(await opts.linearStatus()));
  app.get("/api/integrations/github", (c) => c.json(opts.githubStatus()));
  return app;
}
