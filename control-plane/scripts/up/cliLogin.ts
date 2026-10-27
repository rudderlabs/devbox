// Logs the devbox CLI in: keeps a still-valid token of the named profile in the
// CLI config file, or stores a new one, and makes the
// profile current. The file is the only place a token is written: mode 0600
// in a 0700 directory. `bun run up` uses profile "local", `bun run
// k8s:install` one per cluster.
import { readFileSync } from "node:fs";
import { configFilePath, realConfigFs } from "../../../cli/interface/configFile";
import { writePrivateFile } from "../../../cli/interface/privateFile";
import {
  EMPTY_PROFILE_FILE,
  type Profile,
  type ProfileFile,
  ProfileFileError,
  parseProfileFile,
  profileOf,
  serializeProfileFile,
  withoutProfile,
  withProfile,
} from "../../../cli/interface/profiles";

// The CLI config file cannot be read or is not a profile file.
export class CliConfigError extends Error {}

export const cliConfigPath = (env: Record<string, string | undefined>, home: string): string =>
  configFilePath(env, { ...realConfigFs, home: () => home });

// A missing file starts afresh; anything else wrong with the file stops, so
// no profile is lost.
function readProfiles(path: string): ProfileFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return EMPTY_PROFILE_FILE;
    throw new CliConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return parseProfileFile(text);
  } catch (err) {
    if (!(err instanceof ProfileFileError)) throw err;
    throw new CliConfigError(`${path} ${err.message}: fix or delete it, then run again`);
  }
}

function writeProfiles(path: string, file: ProfileFile): void {
  writePrivateFile(path, serializeProfileFile(file));
}

export function readCliProfile(path: string, profile: string): Profile | undefined {
  return profileOf(readProfiles(path), profile);
}

export function removeCliProfile(path: string, profile: string): void {
  const file = readProfiles(path);
  if (profileOf(file, profile)) writeProfiles(path, withoutProfile(file, profile));
}

export async function ensureCliLogin(opts: {
  path: string;
  profile: string;
  url: string;
  isValid: (profile: Profile) => Promise<boolean>;
  createToken: () => Promise<string>;
}): Promise<"kept" | "created"> {
  const file = readProfiles(opts.path);
  const existing = profileOf(file, opts.profile);
  if (existing && existing.url === opts.url && (await opts.isValid(existing))) {
    writeProfiles(opts.path, withProfile(file, opts.profile, existing, true));
    return "kept";
  }
  const profile = { url: opts.url, token: await opts.createToken() };
  writeProfiles(opts.path, withProfile(file, opts.profile, profile, true));
  return "created";
}

// `bun run api-token create` prints the token on a line of its own. The rest
// of the output is never echoed, in case it holds the token.
export function parseApiTokenOutput(stdout: string): string {
  const m = /^(dbx_\S+)$/m.exec(stdout);
  if (!m?.[1]) throw new Error("api-token create printed no token");
  return m[1];
}
