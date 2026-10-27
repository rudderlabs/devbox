// The commands the quickstart runs, in order. It coordinates the existing
// scripts rather than repeating them, and runs each script directly (not
// through `bun run`), so `bun run setup` runs once, before the quickstart.
//
// The stack starts first, without new integrations, so a working devbox does
// not wait on a tunnel or an App registration; on kind the GitHub App's setup
// also needs the target file the first k8s:kind writes. Then each chosen
// integration's setup, which writes the config and applies nothing, and the
// start command once more to apply it.
import { KIND_TARGET_FILE } from "../k8s/kind";
import type { Choices } from "./choices";

// `title` is the documented command the user can run alone.
export type Step = { title: string; cmd: string[] };

export type StepOptions = { noKeychain: boolean; publicUrl?: string };

const SCRIPTS = "control-plane/scripts";

export function startStep(c: Choices, o: StepOptions): Step {
  const keychain = o.noKeychain ? ["--no-keychain"] : [];
  return c.platform === "compose"
    ? { title: "bun run up", cmd: ["bun", `${SCRIPTS}/up.ts`, ...keychain] }
    : { title: "bun run k8s:kind", cmd: ["bun", `${SCRIPTS}/k8s.ts`, "kind", ...keychain] };
}

export function integrationSteps(c: Choices, o: StepOptions): Step[] {
  const target = c.platform === "kind" ? ["--target", KIND_TARGET_FILE] : [];
  const extra = [
    ...target,
    ...(o.publicUrl ? ["--public-url", o.publicUrl] : []),
    ...(o.noKeychain ? ["--no-keychain"] : []),
  ];
  const steps: Step[] = [];
  if (c.githubApp) {
    steps.push({
      title: ["bun run github:setup", ...target].join(" "),
      cmd: ["bun", `${SCRIPTS}/github.ts`, "setup", ...extra],
    });
  }
  if (c.linear) {
    steps.push({
      title: ["bun run linear:setup", ...target].join(" "),
      cmd: ["bun", `${SCRIPTS}/linear.ts`, "setup", ...extra],
    });
  }
  return steps;
}

// Where the tunnel for webhooks must point.
export function tunnelHint(c: Choices): string[] {
  if (c.platform === "compose") {
    return [
      "GitHub and Linear send webhooks to a public HTTPS URL that forwards to port 3000",
      "on this machine. Start a tunnel in another terminal, for example `ngrok http 3000`",
      "or `cloudflared tunnel --url http://localhost:3000`; the setup asks for its URL.",
    ];
  }
  return [
    "GitHub and Linear send webhooks to a public HTTPS URL that forwards to the control",
    "plane. On kind, run in another terminal and keep running:",
    `  bun run k8s:connect --target ${KIND_TARGET_FILE}`,
    "then point a tunnel at the port of the localhost URL it prints, for example",
    "`ngrok http <port>`, and enter the tunnel's URL below.",
  ];
}

// The status commands for what is set up, printed at the end.
export function statusCommands(c: Choices, enabled: { githubApp: boolean; linear: boolean }) {
  const target = c.platform === "kind" ? ` --target ${KIND_TARGET_FILE}` : "";
  return [
    ...(c.githubApp || enabled.githubApp ? [`bun run github:status${target}`] : []),
    ...(c.linear || enabled.linear ? [`bun run linear:status${target}`] : []),
  ];
}
