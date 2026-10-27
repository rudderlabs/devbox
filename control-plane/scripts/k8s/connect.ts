// `bun run k8s:connect` port-forwards the control plane on the profile's pinned
// local port, so the saved URL keeps working. `k8s:install`
// runs the same port-forward in the background while it logs the CLI in.
import { cliConfigPath, readCliProfile } from "../up/cliLogin";
import { installCommand } from "./kind";
import { profileNameForContext } from "./profileName";
import { type Kube, KubeError, kube, NAMESPACE, type Runner } from "./run";
import type { Target } from "./target";

const HEALTH_POLL_MS = 500;
const HEALTH_LIMIT_MS = 30_000;

export async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

export async function freePort(
  start: number,
  free: (port: number) => Promise<boolean>,
): Promise<number> {
  for (let port = start; port < start + 100; port++) if (await free(port)) return port;
  throw new KubeError(`no free local port in ${start}-${start + 99}`);
}

export async function assertPortFree(
  port: number,
  profile: string,
  free: (port: number) => Promise<boolean>,
): Promise<void> {
  if (!(await free(port))) {
    throw new KubeError(
      `port ${port} is in use: another \`bun run k8s:connect\` for profile "${profile}" may still be running (stop it, or free the port)`,
    );
  }
}

export function portForwardCommand(k: Kube, port: number): string[] {
  return [
    "kubectl",
    "--context",
    k.context,
    "port-forward",
    "-n",
    NAMESPACE,
    "svc/devbox-control-plane",
    `${port}:3000`,
    "--address",
    "127.0.0.1",
  ];
}

// The CLI profile for a target: its profile, or one named after its context.
export const profileFor = (target: Target): string =>
  target.profile ?? profileNameForContext(target.context);

export type ConnectDeps = {
  runner: Runner;
  target: Target;
  env: Record<string, string | undefined>;
  home: string;
  log: (line: string) => void;
  isPortFree: (port: number) => Promise<boolean>;
  // Runs the command in the foreground and resolves with its exit code.
  forwardForeground: (cmd: string[]) => Promise<number>;
};

// Resolves with the port-forward's exit code.
export async function connect(deps: ConnectDeps): Promise<number> {
  const context = deps.target.context;
  const profile = profileFor(deps.target);
  const saved = readCliProfile(cliConfigPath(deps.env, deps.home), profile);
  if (!saved) {
    throw new KubeError(
      `no CLI profile "${profile}": run \`${installCommand(context, "<file>")}\` first`,
    );
  }
  const url = new URL(saved.url);
  if (url.hostname !== "localhost") {
    deps.log(`profile "${profile}" uses ${saved.url}: no port-forward needed`);
    return 0;
  }
  const port = Number(url.port);
  await assertPortFree(port, profile, deps.isPortFree);
  deps.log(`devbox (profile "${profile}") at ${saved.url}: press Ctrl-C to stop`);
  return deps.forwardForeground(portForwardCommand(kube(deps.runner, context), port));
}

// The production port-forwards. In the background (k8s:install): returns
// once the control plane answers through it.
export async function backgroundPortForward(k: Kube, port: number): Promise<{ stop: () => void }> {
  // kubectl prints a line per connection on stdout: never read, so ignored.
  const proc = Bun.spawn(portForwardCommand(k, port), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let waited = 0; waited < HEALTH_LIMIT_MS; waited += HEALTH_POLL_MS) {
    if (proc.exitCode !== null) break;
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return { stop: () => proc.kill() };
    } catch {
      // not forwarding yet
    }
    await Bun.sleep(HEALTH_POLL_MS);
  }
  proc.kill();
  const stderr = (await new Response(proc.stderr).text()).trim();
  throw new KubeError(
    `the port-forward to the control plane did not come up${stderr ? `: ${stderr}` : ""}`,
  );
}

// In the foreground (k8s:connect): kubectl's own output and Ctrl-C.
export async function foregroundPortForward(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}
