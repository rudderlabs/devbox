import { describe, expect, it } from "bun:test";
import { asJson, conn, fakeOps, testIo } from "../../__tests__/fakes";
import { base, helpText, parsed, usage } from "../../__tests__/parsing";
import { render, run } from "../whoami";

const WHOAMI_HELP = `Usage: devbox whoami [options]

Show the token the API sees

Options:
  --url <url>       API base URL (default: $DEVBOX_CLI_URL or config)
  --token <token>   API token (default: $DEVBOX_CLI_TOKEN or config)
  --profile <name>  profile from the config file (default: $DEVBOX_CLI_PROFILE
                    or the current one)
  --json            print JSON instead of text
  -h, --help        display help for command`;

describe("whoami: parsing", () => {
  it("has its own help", () => {
    expect(helpText(["whoami", "--help"])).toBe(WHOAMI_HELP);
  });

  it.each([
    [["whoami"], base],
    [
      ["whoami", "--url", "http://cp", "--token", "dbx_a_b", "--json"],
      { connection: { url: "http://cp", token: "dbx_a_b" }, json: true },
    ],
  ])("%p", (argv, args) => {
    expect(parsed(argv)).toEqual({ name: "whoami", args });
  });

  it.each([
    [["whoami", "--verbose"], "unknown option '--verbose'"],
    [
      ["whoami", "extra"],
      "too many arguments for 'whoami'. Expected 0 arguments but got 1: extra.",
    ],
  ])("rejects %p", (argv, message) => {
    expect(usage(argv)).toEqual({ message, command: "whoami" });
  });
});

describe("whoami: render", () => {
  it("names the token, or says auth is off", () => {
    expect(render({ token: { id: "tok-1", name: "frodo" } })).toBe("frodo (token tok-1)");
    expect(render({ token: null, auth: "disabled" })).toBe("auth is disabled on this server");
  });
});

describe("whoami: run", () => {
  it("prints the token name, or JSON", async () => {
    const me = { token: { id: "tok-1", name: "frodo" } };
    const { ops, calls } = fakeOps({ whoami: async () => me });
    const io = testIo();
    expect(await run(conn, ops, io)).toBe(0);
    expect(io.stdout).toEqual(["frodo (token tok-1)"]);
    expect(calls).toEqual([{ op: "whoami", arg: undefined }]);

    const json = testIo();
    await run(asJson, ops, json);
    expect(JSON.parse(json.stdout.join("\n"))).toEqual(me);
  });
});
