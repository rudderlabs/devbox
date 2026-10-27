// A scripted Runner for installer tests: each call must match the next step's
// command exactly; its result defaults to success with empty output.
import type { Runner, RunOptions, RunResult } from "./run";

export type Step = { cmd: string[]; result?: Partial<RunResult> };
export type Call = { cmd: string[]; stdin?: string };

export function fakeRunner(script: Step[]): { runner: Runner; calls: Call[]; done: () => void } {
  const calls: Call[] = [];
  let i = 0;
  const runner: Runner = async (cmd: string[], opts?: RunOptions) => {
    calls.push({ cmd, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const step = script[i++];
    if (!step || JSON.stringify(step.cmd) !== JSON.stringify(cmd)) {
      throw new Error(
        `unexpected command #${i}: ${cmd.join(" ")}\n  expected: ${step?.cmd.join(" ") ?? "(none)"}`,
      );
    }
    return { code: 0, stdout: "", stderr: "", ...step.result };
  };
  return {
    runner,
    calls,
    done: () => {
      if (i !== script.length)
        throw new Error(`${script.length - i} scripted command(s) never ran`);
    },
  };
}
