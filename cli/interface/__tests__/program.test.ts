import { describe, expect, it } from "bun:test";
import { parse } from "../program";
import { helpText, parsed, usage } from "./parsing";

const ROOT_HELP = `Usage: devbox [options] [command]

A thin CLI over the harness control-plane API.

Options:
  -h, --help                        display help for command

Commands:
  whoami [options]                  Show the token the API sees
  create [options] <title> [input]  Create a task and print its key
  ls [options]                      List tasks, newest first
  show [options] <ref>              Show a task's state, sandbox, PRs and rounds
  send [options] <ref> [message]    Send a follow-up message
  restart [options] <ref>           Restart a task from a clean slate
  logs [options] <ref>              Print a task's event log
  wait [options] <ref>              Wait for a task to finish and print its
                                    final response
  profile                           List and switch the control planes the CLI
                                    talks to
  help [command]                    display help for command

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

describe("parse", () => {
  it("prints the root help for --help, help, and no arguments", () => {
    expect(helpText(["--help"])).toBe(ROOT_HELP);
    expect(helpText(["help"])).toBe(ROOT_HELP);
    expect(helpText([])).toBe(ROOT_HELP);
  });

  it("parses profile commands as local commands", () => {
    expect(parse(["profile", "use", "x"])).toMatchObject({ kind: "local", name: "profile use" });
  });

  it("takes --profile on control plane commands", () => {
    expect(parsed(["ls", "--profile", "k8s-eks"]).args).toMatchObject({
      connection: { profile: "k8s-eks" },
    });
  });

  it("prints a command's help for help <command> as for <command> --help", () => {
    expect(helpText(["help", "whoami"])).toBe(helpText(["whoami", "--help"]));
  });

  it.each([
    [["nope"], "unknown command 'nope'"],
    [["whoam"], "unknown command 'whoam'\n(Did you mean whoami?)"],
    [["crate", "x"], "unknown command 'crate'\n(Did you mean create?)"],
    [["constructor", "x"], "unknown command 'constructor'"],
  ])("rejects %p", (argv, message) => {
    expect(usage(argv)).toEqual({ message, command: undefined });
  });
});
