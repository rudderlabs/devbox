import { describe, expect, it, mock } from "bun:test";
import { readdirSync } from "node:fs";
import { sql } from "drizzle-orm";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
mock.module("../../config", () => ({ config: { databaseUrl: TEST_DATABASE_URL } }));

const { db } = await import("../index");
const { runMigrations, MIGRATION_LOCK } = await import("../migrate");

describe("runMigrations", () => {
  it("serializes concurrent runners with an advisory lock", async () => {
    // Two pods booting at once: both must resolve, and the single baseline
    // migration is applied exactly once.
    await Promise.all([runMigrations(), runMigrations(), runMigrations()]);
    const [applied] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    const files = readdirSync("./drizzle").filter((f) => f.endsWith(".sql"));
    expect(applied?.n).toBe(files.length);
    // The lock is released afterwards.
    const [held] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${MIGRATION_LOCK}`,
    );
    expect(held?.n).toBe(0);
  });
});
