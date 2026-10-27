// Runs a command and captures its output. Throws only if it can't start.
// With timeoutMs, kills the command when it runs longer and returns without
// waiting for its output (a child may still hold the pipes open), which is
// why `expired` races `done`.
export type Captured = { code: number; stdout: string; stderr: string; timedOut: boolean };

export async function capture(
  cmd: string[],
  opts: { env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number } = {},
): Promise<Captured> {
  const proc = Bun.spawn(cmd, {
    env: opts.env ?? process.env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const done = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]): Captured => ({ code, stdout, stderr, timedOut: false }));
  if (opts.timeoutMs === undefined) return done;
  let timer: Timer | undefined;
  const expired = new Promise<Captured>((resolve) => {
    timer = setTimeout(() => {
      proc.kill();
      resolve({
        code: -1,
        stdout: "",
        stderr: `timed out after ${opts.timeoutMs} ms`,
        timedOut: true,
      });
    }, opts.timeoutMs);
  });
  try {
    return await Promise.race([done, expired]);
  } finally {
    clearTimeout(timer);
  }
}
