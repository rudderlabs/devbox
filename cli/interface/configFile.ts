// The CLI config file is $XDG_CONFIG_HOME/devbox/config.json, or
// ~/.config/devbox/config.json when XDG_CONFIG_HOME is unset. It holds named
// profiles (profiles.ts).
// `bun run up`, `bun run k8s:install` and `devbox profile` write it.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./usageError";
import { writePrivateFile } from "./privateFile";
import {
  type ProfileFile,
  ProfileFileError,
  parseProfileFile,
  serializeProfileFile,
} from "./profiles";

// File access, injected so tests never touch the real home directory.
export type ConfigFs = {
  home: () => string;
  // Throw an error with a `code` (e.g. ENOENT, EACCES) on failure.
  read: (path: string) => string;
  mode: (path: string) => number;
  write: (path: string, text: string) => void;
};

export const realConfigFs: ConfigFs = {
  home: homedir,
  read: (path) => readFileSync(path, "utf8"),
  mode: (path) => statSync(path).mode & 0o777,
  write: writePrivateFile,
};

const HINT = "run `bun run up` or `bun run k8s:install`, or pass --url/--token";

export function configFilePath(env: Record<string, string | undefined>, fs: ConfigFs): string {
  return join(env.XDG_CONFIG_HOME || join(fs.home(), ".config"), "devbox", "config.json");
}

// The file's contents, or undefined when it doesn't exist. Anything else wrong
// with it is a usage error naming the path and what to run.
export function loadConfigFile(
  path: string,
  fs: ConfigFs,
  warn: (line: string) => void,
): ProfileFile | undefined {
  let text: string;
  try {
    text = fs.read(path);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") return undefined;
    throw new UsageError(
      `cannot read ${path} (${typeof code === "string" ? code : "error"}): ${HINT}`,
    );
  }
  let file: ProfileFile;
  try {
    file = parseProfileFile(text);
  } catch (err) {
    if (err instanceof ProfileFileError) throw new UsageError(`${path} ${err.message}: ${HINT}`);
    throw err;
  }
  try {
    const mode = fs.mode(path);
    if (mode & 0o077) {
      warn(
        `devbox: warning: ${path} has mode 0${mode.toString(8)}, so other users may read its token; run: chmod 600 ${path}`,
      );
    }
  } catch {
    // Read a moment ago; a failed stat only skips the warning.
  }
  return file;
}

export function writeConfigFile(path: string, file: ProfileFile, fs: ConfigFs): void {
  fs.write(path, serializeProfileFile(file));
}
