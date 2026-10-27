import { describe, expect, it } from "bun:test";
import { ApiFailure, type ClientConfig } from "../../core/api";
import { NoEventLog } from "../../core/events";
import type { CoreOps } from "../../core/ops";
import { runCli } from "../main";
import { parse } from "../program";
import { failing, fakeOps, testIo } from "./fakes";

const CONFIG = "/home/me/.config/devbox/config.json";

const profileText = (token: string) =>
  JSON.stringify({ current: "local", profiles: { local: { url: "http://file", token } } });
const FILE_TEXT = profileText("dbx_file");
const OLD_TEXT = profileText("dbx_old");

const noOps = (): CoreOps => {
  throw new Error("makeOps must not be called");
};

const withOps =
  (impl: Partial<CoreOps>, configs: ClientConfig[] = []) =>
  (config: ClientConfig) => {
    configs.push(config);
    return fakeOps(impl).ops;
  };

describe("runCli", () => {
  it("prints help without building the core", async () => {
    const io = testIo();
    expect(await runCli(["--help"], io, noOps)).toBe(0);
    const help = parse(["--help"]);
    expect(io.stdout).toEqual([help.kind === "help" ? help.text : ""]);
  });

  it("runs a local command without building the core", async () => {
    const io = testIo({ env: {} });
    expect(await runCli(["profile", "ls"], io, noOps)).toBe(0);
    expect(io.stdout).toEqual(["no profiles: run `bun run up` or `bun run k8s:install`"]);
  });

  it("maps a usage error to exit 10 with the command's help hint", async () => {
    const io = testIo();
    expect(await runCli(["whoami", "extra"], io, noOps)).toBe(10);
    expect(io.stderr).toEqual([
      "devbox: too many arguments for 'whoami'. Expected 0 arguments but got 1: extra.",
      "Run 'devbox whoami --help' for usage.",
    ]);
  });

  it("uses the root help hint when there is no command", async () => {
    const io = testIo();
    expect(await runCli(["nope"], io, noOps)).toBe(10);
    expect(io.stderr).toEqual(["devbox: unknown command 'nope'", "Run 'devbox --help' for usage."]);
  });

  it("builds the core from flags over env", async () => {
    const configs: ClientConfig[] = [];
    const code = await runCli(
      ["whoami", "--url", "http://flag/"],
      testIo(),
      withOps({ whoami: async () => ({ token: null, auth: "disabled" }) }, configs),
    );
    expect(code).toBe(0);
    expect(configs).toEqual([{ url: "http://flag", token: "dbx_tok_SECRET" }]);
  });

  it("exits 10 without a URL or config file, saying what to run", async () => {
    const io = testIo({ env: {} });
    expect(await runCli(["whoami"], io, noOps)).toBe(10);
    expect(io.stderr).toEqual([
      `devbox: no API URL and no profile in ${CONFIG}: run \`bun run up\` or \`bun run k8s:install\`, or pass --url/--token`,
      "Run 'devbox --help' for usage.",
    ]);
  });

  it("reads the config file when no flag or env gives a URL", async () => {
    const configs: ClientConfig[] = [];
    const io = testIo({
      env: {},
      configFiles: { [CONFIG]: { text: FILE_TEXT } },
    });
    const ops = withOps({ whoami: async () => ({ token: null, auth: "disabled" }) }, configs);
    expect(await runCli(["whoami"], io, ops)).toBe(0);
    expect(configs).toEqual([{ url: "http://file", token: "dbx_file" }]);
    expect(io.stderr).toEqual([]);
  });

  it("warns about a too-open config file and still uses it", async () => {
    const configs: ClientConfig[] = [];
    const io = testIo({
      env: {},
      configFiles: { [CONFIG]: { text: FILE_TEXT, mode: 0o644 } },
    });
    const ops = withOps({ whoami: async () => ({ token: null, auth: "disabled" }) }, configs);
    expect(await runCli(["whoami"], io, ops)).toBe(0);
    expect(configs).toEqual([{ url: "http://file", token: "dbx_file" }]);
    expect(io.stderr).toEqual([
      `devbox: warning: ${CONFIG} has mode 0644, so other users may read its token; run: chmod 600 ${CONFIG}`,
    ]);
  });

  it("exits 10 without a stack for an unreadable or broken config file", async () => {
    for (const [file, message] of [
      [{ error: "EACCES" }, `cannot read ${CONFIG} (EACCES)`],
      [{ text: "{" }, `${CONFIG} is not valid JSON`],
    ] as const) {
      const io = testIo({ env: {}, configFiles: { [CONFIG]: file } });
      expect(await runCli(["whoami"], io, noOps)).toBe(10);
      expect(io.stderr).toEqual([
        `devbox: ${message}: run \`bun run up\` or \`bun run k8s:install\`, or pass --url/--token`,
        "Run 'devbox --help' for usage.",
      ]);
    }
  });

  it("says how to log in again when the profile's token is rejected", async () => {
    const io = testIo({
      env: {},
      configFiles: { [CONFIG]: { text: OLD_TEXT } },
    });
    const failure = new ApiFailure(
      401,
      "unauthorized",
      "invalid or missing token (401 unauthorized)",
    );
    const ops = withOps({
      whoami: async () => {
        throw failure;
      },
    });
    expect(await runCli(["whoami"], io, ops)).toBe(10);
    expect(io.stderr).toEqual([
      "devbox: invalid or missing token (401 unauthorized)",
      `The token of profile "local" in ${CONFIG} is no longer valid: log in again with \`bun run up\` or \`bun run k8s:install\`.`,
    ]);
  });

  it("prints an ApiFailure's message only", async () => {
    const io = testIo();
    const failure = new ApiFailure(
      401,
      "unauthorized",
      "invalid or missing token (401 unauthorized)",
    );
    const code = await runCli(
      ["whoami"],
      io,
      withOps({
        whoami: async () => {
          throw failure;
        },
      }),
    );
    expect(code).toBe(10);
    expect(io.stderr).toEqual(["devbox: invalid or missing token (401 unauthorized)"]);
  });

  it("prints an InputError's message only", async () => {
    const io = testIo();
    expect(await runCli(["create", "T", "-i", "missing.md"], io, withOps({}))).toBe(10);
    expect(io.stderr).toEqual([
      "devbox: cannot read missing.md: ENOENT: no such file 'missing.md'",
    ]);
  });

  it("adds the stack for unexpected errors", async () => {
    const io = testIo();
    const code = await runCli(
      ["whoami"],
      io,
      withOps({
        whoami: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(code).toBe(10);
    expect(io.stderr[0]).toBe("devbox: boom");
    expect(io.stderr).toHaveLength(2);
    expect(io.stderr[1]).toContain("Error: boom");
  });

  it("prints a NoEventLog's message only", async () => {
    const io = testIo();
    const code = await runCli(
      ["wait", "ABC-1"],
      io,
      withOps({ followTask: () => failing(new NoEventLog("ABC-1")) }),
    );
    expect(code).toBe(10);
    expect(io.stderr).toEqual(["devbox: ABC-1 has no event log (only API tasks are logged)"]);
  });
});
