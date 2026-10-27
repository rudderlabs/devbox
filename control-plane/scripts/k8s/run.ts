// Runs kubectl and helm for the installer. Every call goes through a
// Runner, so tests swap in a scripted fake and assert the exact commands.
// Every kubectl/helm call names the context, so the installer never acts on
// whatever context happens to be current.

import { capture } from "../lib/capture";

export const RELEASE = "devbox";
export const NAMESPACE = "devbox";
export const SANDBOX_NAMESPACE = "devbox-sandboxes";
export { REPO_SNAPSHOT_SELECTOR as REPO_SNAPSHOTS } from "../../src/clients/repoSnapshots";

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { stdin?: string; timeoutMs?: number };
export type Runner = (cmd: string[], opts?: RunOptions) => Promise<RunResult>;

export class KubeError extends Error {}

export const realRunner: Runner = async (cmd, opts = {}) => {
  try {
    const { code, stdout, stderr } = await capture(cmd, {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
    });
    return { code, stdout, stderr };
  } catch {
    throw new KubeError(
      `${cmd[0]} not found: install it (docs/kubernetes/README.md#prerequisites)`,
    );
  }
};

export type Kube = {
  context: string;
  kubectl: (args: string[], opts?: RunOptions) => Promise<RunResult>;
  helm: (args: string[], opts?: RunOptions) => Promise<RunResult>;
  // Like kubectl/helm, but return stdout and throw KubeError on failure.
  kubectlOk: (args: string[], opts?: RunOptions) => Promise<string>;
  helmOk: (args: string[], opts?: RunOptions) => Promise<string>;
};

function ok(tool: string, args: string[], r: RunResult): string {
  if (r.code !== 0) {
    throw new KubeError(
      `${tool} ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`,
    );
  }
  return r.stdout;
}

export function kube(runner: Runner, context: string): Kube {
  const kubectl = (args: string[], opts?: RunOptions) =>
    runner(["kubectl", "--context", context, ...args], opts);
  const helm = (args: string[], opts?: RunOptions) =>
    runner(["helm", "--kube-context", context, ...args], opts);
  return {
    context,
    kubectl,
    helm,
    kubectlOk: async (args, opts) => ok("kubectl", args, await kubectl(args, opts)),
    helmOk: async (args, opts) => ok("helm", args, await helm(args, opts)),
  };
}
