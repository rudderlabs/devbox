import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { logger } from "../logger";

type DbProbe = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export class HealthController {
  constructor(private readonly db: DbProbe) {}

  async check(c: Context): Promise<Response> {
    try {
      await this.db.execute(sql`select 1`);
    } catch (err) {
      // Don't leak raw DB error to unauthenticated clients — Postgres/bun-sql
      // messages can surface DSN usernames, connection strings, internal hostnames.
      logger.error("healthcheck db probe failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return c.json({ status: "error", db: "down" }, 503);
    }
    return c.json({ status: "ok", db: "up" });
  }
}
