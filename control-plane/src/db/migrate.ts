import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { config } from "../config";
import * as schema from "./schema";

// A constant advisory lock key: every control-plane pod that boots takes it
// before migrating, so with more than one replica the second waits and finds
// nothing to do. Session-level, on a client with one connection, so the lock,
// the migrator's own transaction and the unlock share that connection.
export const MIGRATION_LOCK = 7355608;

export async function runMigrations() {
  const client = new SQL(config.databaseUrl, { max: 1 });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(drizzle({ client, schema }), { migrationsFolder: "./drizzle" });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  await runMigrations();
}
