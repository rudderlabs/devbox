// `bun run setup`: checks the Bun version, then installs the packages of the
// control plane and the CLI. `bun run up` runs it first. It imports no
// packages, so it runs before anything is installed and an old Bun gets a
// clear message instead of an install error.
import { join } from "node:path";
import { bunVersionError } from "./up/bunVersion";

const ROOT = join(import.meta.dir, "..", "..");

const tooOld = bunVersionError(Bun.version);
if (tooOld) {
  process.stderr.write(`bun run setup: ${tooOld}\n`);
  process.exit(1);
}
for (const dir of ["control-plane", "cli"]) {
  const proc = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
    cwd: join(ROOT, dir),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.stderr.write(`bun run setup: bun install in ${dir}/ failed (exit ${code})\n`);
    process.exit(1);
  }
}
