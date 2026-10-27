import { Hono } from "hono";
import type { HealthController } from "../controllers/health.controller";

export function createHealthRoutes(controller: HealthController): Hono {
  const app = new Hono();
  app.get("/health", (c) => controller.check(c));
  return app;
}
