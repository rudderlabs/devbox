// 0003 turns tasks.source from the task_source enum into text while pods of
// the previous release are still running. Those pods keep the statements they
// prepared, with source parameters of the enum type. This replays that on a
// scratch database: one connection prepares them before 0003 and runs them
// again after it.
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

// What a previous-release pod runs with source bound as a parameter: a lookup
// by source (findByExternalId), the claim filter (claimNext,
// listInFlightOwnedBy) and a task insert (assign, API creates). Bun prepares
// each on its first run and reuses it on the same connection.
const oldPodQueries = (c: SQL) => [
  () => c`SELECT id FROM tasks WHERE source = ${"linear"} AND external_id = ${"issue-1"}`,
  () => c`SELECT id FROM tasks WHERE source IN ${c(["linear", "api"])}`,
  () => c`
    INSERT INTO tasks (source, external_id, key, title, external_url)
    VALUES (${"api"}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 't', 'u')
    ON CONFLICT (source, external_id) DO NOTHING`,
];

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
  // 0003 is applied (`skip` leaves out statements); the pod runs them again.
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
      for (const run of oldPodQueries(oldPod)) await run();

      // Like the migrator: one transaction, so SET LOCAL holds.
      await migrator.begin(async (tx) => {
        for (const s of statements(SOURCE_TEXT)) if (!skip(s)) await tx.unsafe(s);
      });

      const after: string[] = [];
      for (const run of oldPodQueries(oldPod)) {
        after.push(
          await run().then(
            () => "ok",
            (err: Error) => err.message,
          ),
        );
      }
      const [column] = await migrator`
        SELECT data_type FROM information_schema.columns
         WHERE table_name = 'tasks' AND column_name = 'source'`;
      return { after, type: column?.data_type };
    } finally {
      await oldPod.close();
      await migrator.close();
    }
  }

  it("makes source text, and the old pod's statements keep working", async () => {
    expect(await upgrade(() => false)).toEqual({ after: ["ok", "ok", "ok"], type: "text" });
  });

  it("without the cast, the old pod's comparisons on source fail", async () => {
    // The insert still works: Postgres converts any type to text on assignment.
    expect(await upgrade((s) => s.includes("CREATE CAST"))).toEqual({
      after: [
        "operator does not exist: text = task_source",
        "operator does not exist: text = task_source",
        "ok",
      ],
      type: "text",
    });
  });
});
