import type { RoundResult } from "../core/events";

// `interrupted` follows the shell exit-code convention for SIGINT.
export const EXIT = {
  ok: 0,
  failed: 1,
  partial: 2,
  timeout: 3,
  error: 10,
  interrupted: 130,
} as const;

export function exitCodeFor(result: RoundResult): number {
  if (result.failed) return EXIT.failed;
  return result.outcome === "partial_failure" ? EXIT.partial : EXIT.ok;
}
