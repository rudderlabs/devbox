import { parseArgs } from "node:util";
import { setup as setupLogger } from "../src/logger";
import {
  type ApiTokenRepository,
  apiTokenRepository,
} from "../src/repositories/apiToken.repository";
import {
  formatApiToken,
  generateApiTokenSecret,
  hashApiTokenSecret,
} from "../src/services/apiAuth.service";

// bun run api-token create <name> [--github-login <login>] | list | revoke <name>
// Output goes to stdout directly: the logger redacts /token/i, and `create`
// must print the token (once).
const USAGE =
  "Usage: bun run api-token create <name> [--github-login <login>] | list | revoke <name>\n";

export async function runApiTokenCommand(
  argv: string[],
  deps: { repo: ApiTokenRepository; out: (s: string) => void; err: (s: string) => void },
): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "create") {
    const { positionals, values } = parseArgs({
      args: rest,
      options: { "github-login": { type: "string" } },
      allowPositionals: true,
    });
    const name = positionals[0];
    if (!name || positionals.length > 1) return usage(deps);
    if (await deps.repo.findByName(name)) {
      deps.err(`An API token named "${name}" already exists.\n`);
      return 1;
    }
    const secret = generateApiTokenSecret();
    const { id } = await deps.repo.create({
      name,
      secretHash: await hashApiTokenSecret(secret),
      githubLogin: values["github-login"] ?? null,
    });
    deps.out(
      `Created API token "${name}" (id ${id}).\nStore it now. It is not shown again.\n\n${formatApiToken(id, secret)}\n`,
    );
    return 0;
  }
  if (cmd === "list" && rest.length === 0) {
    const iso = (d: Date | null) => (d ? d.toISOString() : "-");
    const lines = ["NAME\tID\tCREATED\tLAST USED\tREVOKED"];
    for (const t of await deps.repo.list()) {
      lines.push([t.name, t.id, iso(t.createdAt), iso(t.lastUsedAt), iso(t.revokedAt)].join("\t"));
    }
    deps.out(`${lines.join("\n")}\n`);
    return 0;
  }
  if (cmd === "revoke" && rest.length === 1 && rest[0]) {
    if (!(await deps.repo.revokeByName(rest[0]))) {
      deps.err(`No active API token named "${rest[0]}".\n`);
      return 1;
    }
    deps.out(`Revoked API token "${rest[0]}".\n`);
    return 0;
  }
  return usage(deps);
}

function usage(deps: { err: (s: string) => void }): number {
  deps.err(USAGE);
  return 1;
}

if (import.meta.main) {
  setupLogger("api-token", {}, [/token/i, /secret/i, /password/i, /authorization/i]);
  const code = await runApiTokenCommand(process.argv.slice(2), {
    repo: apiTokenRepository,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exit(code);
}
