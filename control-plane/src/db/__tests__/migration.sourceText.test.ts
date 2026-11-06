// 0003 turns tasks.source from the task_source enum into text while pods of
// the previous release are still running. Those pods keep the statements they
// prepared, with source parameters of the enum type and source results of that
// type. This replays that on a scratch database: one connection prepares them
// before 0003 and runs them twice after it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SQL } from "bun";

const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
const SOURCE_TEXT = "0003_task_source_text";
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: Array<{ tag: string }>;
};
const tags = journal.entries.map((e) => e.tag);
// The migrations before 0003.
const before = tags.slice(0, tags.indexOf(SOURCE_TEXT));

const statements = (tag: string): string[] =>
  readFileSync(`drizzle/${tag}.sql`, "utf8")
    .split("--> statement-breakpoint")
    .filter((s) => s.trim());

// What a previous-release pod runs that binds or returns source. Bun prepares
// each on its first run and reuses it on the same connection.
const oldPodQueries = (c: SQL) => ({
  // findByExternalId: returns every column, outside a transaction.
  lookup: () => c`SELECT * FROM tasks WHERE source = ${"linear"} AND external_id = ${"issue-1"}`,
  // claimNext, listInFlightOwnedBy.
  claim: () => c`SELECT id FROM tasks WHERE source IN ${c(["linear", "api"])}`,
  // assign, API creates.
  insert: () => c`
    INSERT INTO tasks (source, external_id, key, title, external_url)
    VALUES (${"api"}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 't', 'u')
    ON CONFLICT (source, external_id) DO NOTHING`,
  // recordEventCursor: returns source, inside a transaction.
  returnsSourceInTx: () =>
    c.begin(
      (tx) => tx`
        UPDATE tasks SET updated_at = now() WHERE external_id = ${"ext-1"}
        RETURNING id, source`,
    ),
});

const ok = { lookup: "ok", claim: "ok", insert: "ok", returnsSourceInTx: "ok" };
const NO_OPERATOR = "operator does not exist: text = task_source";
// Postgres rejects a cached statement whose result type changed. Bun prepares
// it again and retries outside a transaction; inside one it can't, so the
// error reaches the caller, once per connection.
const RESULT_CHANGED = "cached plan must not change result type";

describe("migration 0003 under a rolling deploy", () => {
  const admin = new SQL(BASE_URL);
  const scratch: string[] = [];

  beforeAll(() => {
    expect(before).toEqual(tags.slice(0, 3));
  });

  afterAll(async () => {
    for (const name of scratch)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close();
  });

  // A scratch database at 0002; a previous-release pod prepares its queries;
  // 0003 is applied (`skip` leaves out statements); the pod runs them twice.
  async function upgrade(skip: (statement: string) => boolean) {
    const name = `devbox_migration_source_text_${process.pid}_${Date.now()}_${scratch.length}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    scratch.push(name);
    const url = new URL(BASE_URL);
    url.pathname = `/${name}`;
    const migrator = new SQL(url.toString(), { max: 1 });
    const oldPod = new SQL(url.toString(), { max: 1 });
    try {
      for (const tag of before) for (const s of statements(tag)) await migrator.unsafe(s);
      await migrator`
        INSERT INTO tasks (source, external_id, key, title, external_url)
        VALUES ('api', 'ext-1', 'K-1', 't', 'u')`;
      for (const run of Object.values(oldPodQueries(oldPod))) await run();

      // Like the migrator: one transaction, so SET LOCAL holds.
      await migrator.begin(async (tx) => {
        for (const s of statements(SOURCE_TEXT)) if (!skip(s)) await tx.unsafe(s);
      });

      const pass = async () => {
        const out: Record<string, string> = {};
        for (const [query, run] of Object.entries(oldPodQueries(oldPod))) {
          out[query] = await run().then(
            () => "ok",
            (err: Error) => err.message,
          );
        }
        return out;
      };
      const first = await pass();
      const second = await pass();
      const [column] = await migrator`
        SELECT data_type FROM information_schema.columns
         WHERE table_name = 'tasks' AND column_name = 'source'`;
      return { first, second, type: column?.data_type };
    } finally {
      await oldPod.close();
      await migrator.close();
    }
  }

  it("makes source text; the old pod's comparisons keep working, and a statement returning source fails once inside a transaction", async () => {
    expect(await upgrade(() => false)).toEqual({
      first: { ...ok, returnsSourceInTx: RESULT_CHANGED },
      second: ok,
      type: "text",
    });
  });

  it("without the cast, the old pod's comparisons on source keep failing", async () => {
    // The insert still works: Postgres converts any type to text on assignment.
    const comparisonsFail = { ...ok, lookup: NO_OPERATOR, claim: NO_OPERATOR };
    expect(await upgrade((s) => s.includes("CREATE CAST"))).toEqual({
      first: { ...comparisonsFail, returnsSourceInTx: RESULT_CHANGED },
      second: comparisonsFail,
      type: "text",
    });
  });
});
