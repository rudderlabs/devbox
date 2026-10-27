import { readFileSync, writeFileSync } from "node:fs";

// The trimmed key at `path`, or a new one from `generate` written there
// owner-only when the file is missing or empty. One read and at most one
// write: no existence check that the file could change after, and the value
// written is returned rather than read back.
export function readOrCreateKey(path: string, generate: () => string): string {
  let existing = "";
  try {
    existing = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) return existing;
  const key = generate();
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return key;
}
