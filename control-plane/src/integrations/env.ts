// Helpers for reading settings from the environment. Pure: each takes the env,
// so settings are testable without mocking ../config. A bad value throws, which
// fails boot with an error that names the setting.

type Env = Record<string, string | undefined>;

// The trimmed value, or undefined when unset or blank.
export function present(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

// Comma- or whitespace-separated list. Empty or unset yields [].
export function parseTrustList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[\s,]+/).filter(Boolean);
}

// An integration's explicit switch. Exactly "true" turns it on; unset, empty or
// "false" is off; anything else fails startup. Switch values are not secrets,
// so the error echoes the raw value.
export function parseSwitch(env: Env, name: string): boolean {
  const raw = present(env, name);
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

export function missingError(name: string, missing: string[]): Error {
  return new Error(`${name} is true but these are missing: ${missing.join(", ")}`);
}

// Optional numeric setting with a default. Unset or empty/whitespace-only → `def`.
// A PRESENT but non-finite value (typo, "Infinity", a Helm-rendered garbage
// string) THROWS at boot instead of silently coercing to 0/NaN. This matters
// for safety knobs like the ci_result loop breaker: `Number(env ?? d)` would
// let "" / "abc" map to 0/NaN, which the breaker reads as "disabled" — silently
// removing the only guard against a runaway sandbox-recreate loop. An explicit
// finite 0/negative still passes through (a documented, intentional disable).
export function optionalNumber(env: Env, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env var ${name} must be a number`);
  return value;
}
