// Writes a file only its owner can read. Shared by the CLI and the control
// plane's scripts, so it imports nothing but node:fs and node:path.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Written beside the target and renamed over it, so the file never exists
// with a wider mode or half-written. Mode 0600 in a 0700 directory.
export function writePrivateFile(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
