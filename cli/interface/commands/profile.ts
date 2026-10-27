// devbox profile ls|use|add: list and edit the profiles in the CLI config
// file. These run without a control plane.
import type { CommandModule } from "../command";
import { UsageError } from "../command";
import { configFilePath, loadConfigFile, writeConfigFile } from "../configFile";
import type { Io } from "../io";
import { EMPTY_PROFILE_FILE, ProfileFileError, profileOf, withProfile } from "../profiles";

function load(io: Io) {
  const path = configFilePath(io.env, io.configFs);
  return { path, file: loadConfigFile(path, io.configFs, io.err) ?? EMPTY_PROFILE_FILE };
}

export async function runLs(json: boolean, io: Io): Promise<number> {
  const { file } = load(io);
  const names = Object.keys(file.profiles).sort();
  if (json) {
    io.out(
      JSON.stringify(
        {
          current: file.current ?? null,
          profiles: names.map((name) => ({ name, url: file.profiles[name]?.url })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (names.length === 0) {
    io.out("no profiles: run `bun run up` or `bun run k8s:install`");
    return 0;
  }
  const width = Math.max(...names.map((n) => n.length));
  for (const name of names) {
    io.out(
      `${name === file.current ? "*" : " "} ${name.padEnd(width)}  ${file.profiles[name]?.url}`,
    );
  }
  return 0;
}

export async function runUse(name: string, io: Io): Promise<number> {
  const { path, file } = load(io);
  if (!profileOf(file, name)) throw new UsageError(`no profile "${name}" in ${path}`, "profile");
  writeConfigFile(path, { ...file, current: name }, io.configFs);
  io.out(`Using profile ${name}`);
  return 0;
}

export async function runAdd(
  name: string,
  opts: { url: string; token: string; use: boolean },
  io: Io,
): Promise<number> {
  const url = URL.canParse(opts.url) ? new URL(opts.url) : undefined;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new UsageError(`--url must be an http(s) URL, got ${opts.url}`, "profile");
  }
  const { path, file } = load(io);
  let next: ReturnType<typeof withProfile>;
  try {
    next = withProfile(
      file,
      name,
      { url: opts.url.replace(/\/+$/, ""), token: opts.token },
      opts.use,
    );
  } catch (err) {
    if (err instanceof ProfileFileError) throw new UsageError(err.message, "profile");
    throw err;
  }
  writeConfigFile(path, next, io.configFs);
  io.out(`Saved profile ${name}${opts.use ? " and made it current" : ""}`);
  return 0;
}

export const profile: CommandModule = {
  register(program, parsed) {
    const group = program
      .command("profile")
      .description("List and switch the control planes the CLI talks to");
    group
      .command("ls")
      .description("List profiles; * marks the current one")
      .allowExcessArguments(false)
      .option("--json", "print JSON instead of text")
      .action((o: { json?: boolean }) =>
        parsed({ kind: "local", name: "profile ls", run: (io) => runLs(o.json === true, io) }),
      );
    group
      .command("use <name>")
      .description("Make a profile current")
      .allowExcessArguments(false)
      .action((name: string) =>
        parsed({ kind: "local", name: "profile use", run: (io) => runUse(name, io) }),
      );
    group
      .command("add <name>")
      .description("Add or replace a profile (for installs made without k8s:install)")
      .allowExcessArguments(false)
      .requiredOption("--url <url>", "control plane URL")
      .requiredOption("--token <token>", "API token")
      .option("--use", "also make it current")
      .action((name: string, o: { url: string; token: string; use?: boolean }) =>
        parsed({
          kind: "local",
          name: "profile add",
          run: (io) => runAdd(name, { url: o.url, token: o.token, use: o.use === true }, io),
        }),
      );
  },
};
