// `bun run github-token [--once]`: the GitHub App token minter. A
// separate process from the control plane (same image) and the only holder of
// the App's private key. Exits 1 on bad startup input. The loop never exits on
// GitHub errors; `--once` exits 0 after the first write, or 1 when it gives up
// (at once on 401/403/404/422, else after 5 attempts).

import { readFileSync } from "node:fs";
import { MinterGaveUpError, parseMinterInputs, runMinter } from "./githubToken/minter";
import { logger, setup as setupLogger } from "./logger";

// Not the server's /token/i: that would also blank `currentTokenExpiresAt`.
// The minter never logs a credential; these keys are the belt and braces.
setupLogger("devbox-github-token", {}, [
  /^token$/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /jwt/i,
  /private.?key/i,
  /pem/i,
]);

let inputs: ReturnType<typeof parseMinterInputs>;
try {
  inputs = parseMinterInputs(process.env, process.argv.slice(2), (path) =>
    readFileSync(path, "utf8"),
  );
} catch (err) {
  console.error(`github-token: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

try {
  await runMinter({
    ...inputs,
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => Bun.sleep(ms),
    now: () => new Date(),
    log: logger,
  });
} catch (err) {
  if (!(err instanceof MinterGaveUpError)) throw err;
  console.error(`github-token: ${err.message}`);
  process.exit(1);
}
process.exit(0);
