// The oldest Bun devbox supports: the version of the CP Docker image, which
// CI pins as `bun-version` in .github/workflows/cli.yml (a test keeps them equal).
export const MIN_BUN_VERSION = "1.4.4";

// A warning for a Bun older than MIN_BUN_VERSION, or undefined. Compiled
// binaries embed the Bun that built them, so they only warn if built with an older one.
export function bunVersionWarning(version: string): string | undefined {
  return Bun.semver.order(version, MIN_BUN_VERSION) < 0
    ? `devbox: Bun ${version} is older than ${MIN_BUN_VERSION}, the version devbox is built and tested with; upgrade with \`bun upgrade\`.`
    : undefined;
}
