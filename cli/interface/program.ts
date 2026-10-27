// Command-line parsing for devbox builds the commander program from the command
// modules and turns argv into a parsed command or a help request. Parsing runs
// nothing and reads no files, stdin or env.
import { Command, CommanderError } from "commander";
import { type HelpRequest, type LocalCommand, type ParsedCommand, UsageError } from "./command";
import { COMMANDS } from "./commands";

const FOOTER = `
Environment:
  DEVBOX_CLI_URL      API base URL, unless --url is given
  DEVBOX_CLI_TOKEN    API token, unless --token is given
  DEVBOX_CLI_PROFILE  profile to use, unless --profile is given

Config file:
  Without --url or DEVBOX_CLI_URL, the URL and token come from a profile in
  $XDG_CONFIG_HOME/devbox/config.json (default ~/.config/devbox/config.json).
  \`bun run up\` writes the profile "local", \`bun run k8s:install\` one per
  cluster; \`devbox profile ls|use|add\` list and edit them. --token or
  DEVBOX_CLI_TOKEN overrides the profile's token.

Exit codes of wait and --wait:
  0 done, 1 failed, 2 partial failure, 3 timeout, 10 usage or API error,
  130 interrupted`;

export function parse(argv: string[]): ParsedCommand | LocalCommand | HelpRequest {
  let result: ParsedCommand | LocalCommand | undefined;
  let command: string | undefined;
  let output = "";
  const program = new Command("devbox")
    .description("A thin CLI over the harness control-plane API.")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        output += text;
      },
      writeErr: (text) => {
        output += text;
      },
      outputError: () => {},
    })
    .configureHelp({ helpWidth: 80 })
    .showSuggestionAfterError(true)
    .addHelpText("after", FOOTER);
  for (const module of COMMANDS) {
    module.register(program, (parsed) => {
      result = parsed;
    });
  }
  program.hook("preSubcommand", (_program, sub) => {
    command = sub.name();
  });
  try {
    program.parse(argv, { from: "user" });
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (!(err instanceof CommanderError)) throw err;
    // --help, `devbox help [command]`, and no command at all.
    if (err.code === "commander.helpDisplayed" || err.code === "commander.help") {
      return { kind: "help", text: output.trimEnd() };
    }
    throw new UsageError(err.message.replace(/^error: /, ""), command);
  }
  if (!result) throw new UsageError("no command given");
  return result;
}
