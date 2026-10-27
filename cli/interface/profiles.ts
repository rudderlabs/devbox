// The CLI config file contains named profiles, each with a control plane URL
// and API token, plus the current profile. `bun run up` and
// `bun run k8s:install` write it (control-plane/scripts/up/cliLogin.ts);
// the CLI reads it, and `devbox profile use|add` edit it. Pure: no file
// access, and no imports, because the control plane's scripts import it too.

export type Profile = { url: string; token: string };
export type ProfileFile = { current: string | undefined; profiles: Record<string, Profile> };

export const EMPTY_PROFILE_FILE: ProfileFile = { current: undefined, profiles: {} };

// What a kube context sanitizes to (control-plane/scripts/k8s/profileName.ts).
export const PROFILE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export class ProfileFileError extends Error {}

// Own properties only: "constructor" or "toString" name no profile.
export const profileOf = (file: ProfileFile, name: string): Profile | undefined =>
  Object.hasOwn(file.profiles, name) ? file.profiles[name] : undefined;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseProfileFile(text: string): ProfileFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProfileFileError("is not valid JSON");
  }
  if (!isObject(raw) || !isObject(raw.profiles)) {
    throw new ProfileFileError(
      'must hold {"current": "...", "profiles": {"<name>": {"url": "...", "token": "..."}}}',
    );
  }
  const profiles: Record<string, Profile> = {};
  for (const [name, p] of Object.entries(raw.profiles)) {
    if (!PROFILE_NAME.test(name)) throw new ProfileFileError(`has a bad profile name "${name}"`);
    if (!isObject(p) || typeof p.url !== "string" || !p.url || typeof p.token !== "string") {
      throw new ProfileFileError(`profile "${name}" must hold {"url": "...", "token": "..."}`);
    }
    profiles[name] = { url: p.url, token: p.token };
  }
  const current = raw.current;
  if (current !== undefined && (typeof current !== "string" || !Object.hasOwn(profiles, current))) {
    throw new ProfileFileError(`"current" names no profile: ${JSON.stringify(current)}`);
  }
  return { current, profiles };
}

export function serializeProfileFile(file: ProfileFile): string {
  return `${JSON.stringify({ current: file.current, profiles: file.profiles }, null, 2)}\n`;
}

export function withProfile(
  file: ProfileFile,
  name: string,
  profile: Profile,
  makeCurrent: boolean,
): ProfileFile {
  if (!PROFILE_NAME.test(name)) {
    throw new ProfileFileError(
      `bad profile name "${name}": use lower-case letters, digits and "-"`,
    );
  }
  return {
    current: makeCurrent ? name : file.current,
    profiles: { ...file.profiles, [name]: profile },
  };
}

export function withoutProfile(file: ProfileFile, name: string): ProfileFile {
  const { [name]: _removed, ...profiles } = file.profiles;
  return { current: file.current === name ? undefined : file.current, profiles };
}
