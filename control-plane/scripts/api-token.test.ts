import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { sql } from "drizzle-orm";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devbox:devbox@localhost:5432/devbox";
mock.module("../src/config", () => ({ config: { databaseUrl: TEST_DATABASE_URL } }));

const { db } = await import("../src/db");
const { ApiTokenRepository } = await import("../src/repositories/apiToken.repository");
const { ApiAuthService } = await import("../src/services/apiAuth.service");
const { runApiTokenCommand } = await import("./api-token");
const { migrate } = await import("drizzle-orm/bun-sql/migrator");

const repo = new ApiTokenRepository();
const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runApiTokenCommand(argv, {
    repo,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join(""), err: err.join("") };
};

describe("api-token", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE task_events, inbox, tasks, api_tokens RESTART IDENTITY CASCADE`,
    );
  });

  it("create prints the token once; it authenticates; revoke makes it fail", async () => {
    const created = await run(["create", "frodo", "--github-login", "frodo-gh"]);
    expect(created.code).toBe(0);
    const token = created.out.match(/^(dbx_\S+)$/m)?.[1] ?? "";
    const [row] = await db.execute<{ id: string; github_login: string }>(
      sql`SELECT id, github_login FROM api_tokens WHERE name = 'frodo'`,
    );
    expect(created.out).toBe(
      `Created API token "frodo" (id ${(row as { id: string }).id}).\nStore it now. It is not shown again.\n\n${token}\n`,
    );
    expect((row as { github_login: string }).github_login).toBe("frodo-gh");

    const auth = new ApiAuthService(repo);
    expect(await auth.authenticate(`Bearer ${token}`)).toEqual({
      tokenId: (row as { id: string }).id,
      name: "frodo",
    });

    expect(await run(["revoke", "frodo"])).toEqual({
      code: 0,
      out: 'Revoked API token "frodo".\n',
      err: "",
    });
    expect(await auth.authenticate(`Bearer ${token}`)).toBeNull();
    expect(await run(["revoke", "frodo"])).toEqual({
      code: 1,
      out: "",
      err: 'No active API token named "frodo".\n',
    });
  });

  it("list shows name, id, created, last used and revoked", async () => {
    await run(["create", "ci-golden-tasks"]);
    await db.execute(
      sql`UPDATE api_tokens SET created_at = '2026-10-07T12:00:00Z', last_used_at = NULL`,
    );
    const [row] = await db.execute<{ id: string }>(sql`SELECT id FROM api_tokens`);
    expect(await run(["list"])).toEqual({
      code: 0,
      out: `NAME\tID\tCREATED\tLAST USED\tREVOKED\nci-golden-tasks\t${(row as { id: string }).id}\t2026-10-07T12:00:00.000Z\t-\t-\n`,
      err: "",
    });
  });

  it("rejects a duplicate name and bad usage", async () => {
    await run(["create", "frodo"]);
    expect(await run(["create", "frodo"])).toEqual({
      code: 1,
      out: "",
      err: 'An API token named "frodo" already exists.\n',
    });
    expect((await run([])).code).toBe(1);
    expect((await run(["create"])).code).toBe(1);
  });
});
