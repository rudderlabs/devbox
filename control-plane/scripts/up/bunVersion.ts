// The oldest Bun that devbox supports. No package imports: `bun run setup`
// checks it before anything is installed.
export const MIN_BUN = "1.4.4";

// The message to show when `version` is older than MIN_BUN, or undefined.
export function bunVersionError(version: string): string | undefined {
  if (Bun.semver.order(version, MIN_BUN) >= 0) return undefined;
  return `Bun ${version} is too old: devbox needs ${MIN_BUN} or newer (bun upgrade, or brew upgrade bun)`;
}
