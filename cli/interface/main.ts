// runCli: parse argv, build the core, run the command, map errors to exit codes.
import { ApiFailure, type ClientConfig } from "../core/api";
import { NoEventLog } from "../core/events";
import type { CoreOps } from "../core/ops";
import { UsageError } from "./command";
import { type ResolvedConfig, resolveConfig } from "./config";
import { configFilePath, loadConfigFile } from "./configFile";
import { EXIT } from "./exit";
import { InputError } from "./input";
import type { Io } from "./io";
import { parse } from "./program";

export type OpsFactory = (config: ClientConfig) => CoreOps;

export async function runCli(argv: string[], io: Io, makeOps: OpsFactory): Promise<number> {
  let resolved: ResolvedConfig | undefined;
  try {
    const parsed = parse(argv);
    if (parsed.kind === "help") {
      io.out(parsed.text);
      return EXIT.ok;
    }
    if (parsed.kind === "local") return await parsed.run(io);
    const path = configFilePath(io.env, io.configFs);
    resolved = resolveConfig(parsed.args.connection, io.env, {
      path,
      load: () => loadConfigFile(path, io.configFs, io.err),
    });
    return await parsed.run(makeOps(resolved.client), io);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err(`devbox: ${message}`);
    if (err instanceof ApiFailure && err.status === 401 && resolved?.tokenFrom) {
      io.err(
        `The token of profile "${resolved.tokenFrom.profile}" in ${resolved.tokenFrom.path} is no longer valid: log in again with \`bun run up\` or \`bun run k8s:install\`.`,
      );
    } else if (err instanceof UsageError) {
      io.err(
        err.command
          ? `Run 'devbox ${err.command} --help' for usage.`
          : "Run 'devbox --help' for usage.",
      );
    } else if (
      !(err instanceof ApiFailure || err instanceof InputError || err instanceof NoEventLog)
    ) {
      io.err(err instanceof Error && err.stack ? err.stack : String(err));
    }
    return EXIT.error;
  }
}
