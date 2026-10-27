import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SQL } from "bun";

const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
const DB_NAME = `devbox_migration_baseline_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(BASE_URL);
  url.pathname = `/${DB_NAME}`;
  return url.toString();
})();

const OLD_HISTORY_HEAD_MILLIS = 1792183649849;
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

async function applyBaseline(client: SQL): Promise<void> {
  const migration = readFileSync(`drizzle/${journal.entries[0]?.tag}.sql`, "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

describe("baseline migration", () => {
  const admin = new SQL(BASE_URL);
  let client: SQL;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
    client = new SQL(scratchUrl);
    await applyBaseline(client);
  });

  afterAll(async () => {
    await client?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.close();
  });

  it("keeps the timestamp of the squashed history's head", () => {
    // Databases migrated before the squash skip the baseline only while its
    // `when` matches their last applied migration; changing it re-runs init.
    const { tag, when } = journal.entries[0] ?? {};
    expect({ tag, when }).toEqual({ tag: "0000_init", when: OLD_HISTORY_HEAD_MILLIS });
  });

  it("creates the current schema without historical objects", async () => {
    const tables = await client.unsafe(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`);
    expect([...tables]).toEqual([
      { table_name: "api_tokens" },
      { table_name: "inbox" },
      { table_name: "task_events" },
      { table_name: "tasks" },
    ]);

    const enumValues = await client.unsafe(
      `SELECT unnest(enum_range(NULL::task_source))::text AS value`,
    );
    expect([...enumValues]).toEqual([{ value: "linear" }, { value: "api" }]);

    const [historicalObjects] = await client.unsafe(`
      SELECT to_regclass('public.linear_tokens')::text AS linear_tokens,
             to_regtype('public.task_status')::text AS task_status`);
    expect(historicalObjects).toEqual({ linear_tokens: null, task_status: null });
  });

  it("preserves current defaults and indexes", async () => {
    const [task] = await client.unsafe(`
      INSERT INTO tasks (source, external_id, key, title, external_url)
      VALUES ('api', 'external-1', 'DBX-API-1', 'test task', 'https://example.com/task/1')
      RETURNING metadata, pr_urls, last_observed_event_seq::int`);
    expect(task).toEqual({ metadata: {}, pr_urls: [], last_observed_event_seq: 0 });

    const indexes = await client.unsafe(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'inbox_pending_idx',
           'tasks_lease_idx',
           'tasks_owner_sandbox_idx',
           'tasks_pr_urls_gin_idx'
         )
       ORDER BY indexname`);
    expect([...indexes]).toEqual([
      { indexname: "inbox_pending_idx" },
      { indexname: "tasks_lease_idx" },
      { indexname: "tasks_owner_sandbox_idx" },
      { indexname: "tasks_pr_urls_gin_idx" },
    ]);

    const [sequence] = await client.unsafe(`SELECT nextval('api_task_key_seq')::int AS value`);
    expect(sequence).toEqual({ value: 1 });
  });
});
