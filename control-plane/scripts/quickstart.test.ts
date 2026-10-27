import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type QuickstartDeps, QuickstartError, quickstart } from "./quickstart";
import { ChoiceError } from "./quickstart/choices";
import { ConfigMissing } from "./quickstart/configReport";
import type { Ran } from "./quickstart/prerequisites";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONFIG = {
  repos: [{ url: "https://github.com/frodo/ring.git" }],
  llm: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" },
};
const CONFIG_WRITTEN = { ...CONFIG, repos: [{ ...CONFIG.repos[0], branch: "main" }] };

// A checkout with devbox.config.json (and devbox.kind.json if given); every
// tool present; each step exits with the next code in `codes` (default 0).
function world(
  opts: {
    config?: unknown;
    kindTarget?: unknown;
    answers?: (string | boolean)[];
    isTTY?: boolean;
    codes?: number[];
    tools?: Record<string, Ran>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "devbox-quickstart-"));
  dirs.push(root);
  if (opts.config !== null) {
    writeFileSync(join(root, "devbox.config.json"), JSON.stringify(opts.config ?? CONFIG));
  }
  if (opts.kindTarget) {
    writeFileSync(join(root, "devbox.kind.json"), JSON.stringify(opts.kindTarget));
  }
  const answers = [...(opts.answers ?? [])];
  const codes = [...(opts.codes ?? [])];
  const asked: string[] = [];
  const log: string[] = [];
  const steps: string[] = [];
  const next = (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`unexpected question: ${q}`);
    return a;
  };
  const deps: QuickstartDeps = {
    root,
    isTTY: opts.isTTY ?? true,
    promptLine: async (q) => String(next(q)),
    confirm: async (q, { defaultYes }) => {
      const a = next(q);
      return a === "" ? defaultYes : a === true;
    },
    log: (l) => void log.push(l),
    run: async (cmd) =>
      opts.tools?.[cmd.slice(0, 2).join(" ")] ?? {
        code: 0,
        stdout: cmd[1] === "info" ? `28.0.1 ${16 * 1024 ** 3}` : "v3.17.1 kind v0.27.0 2.29.1",
        stderr: "",
      },
    exec: async (cmd, cwd) => {
      expect(cwd).toBe(root);
      steps.push(cmd.slice(1).join(" "));
      return codes.shift() ?? 0;
    },
  };
  return { deps, asked, log, steps };
}

const ALL_NO = ["--compose", "--no-github-app", "--no-linear"];

describe("quickstart", () => {
  it("with every flag, asks nothing and runs up once", async () => {
    const w = world({ isTTY: false });
    await quickstart(ALL_NO, w.deps);
    expect(w.asked).toEqual([]);
    expect(w.steps).toEqual(["control-plane/scripts/up.ts"]);
    expect(w.log).toContain("  frodo/ring (branch main)");
    expect(w.log).toContain("platform compose; GitHub App setup: no; Linear setup: no");
  });

  it("without a terminal, names every flag still needed before doing anything", async () => {
    const w = world({ isTTY: false });
    await expect(quickstart(["--kind"], w.deps)).rejects.toThrow(ChoiceError);
    await expect(quickstart(["--kind"], w.deps)).rejects.toThrow(
      "pass --github-app or --no-github-app, --linear or --no-linear",
    );
    expect(w.steps).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("asks for what the flags leave open", async () => {
    const w = world({ answers: ["kind", "", ""] });
    await quickstart([], w.deps);
    expect(w.asked).toEqual([
      "Run devbox with Docker Compose or on a local kind cluster? [compose/kind] ",
      "Set up the GitHub App? [y/N] ",
      "Set up Linear? [y/N] ",
    ]);
    expect(w.steps).toEqual(["control-plane/scripts/k8s.ts kind"]);
  });

  it("starts the stack, sets up the integrations, then applies them", async () => {
    const w = world();
    await quickstart(
      ["--compose", "--github-app", "--linear", "--public-url", "https://hooks.example.com"],
      w.deps,
    );
    expect(w.steps).toEqual([
      "control-plane/scripts/up.ts",
      "control-plane/scripts/github.ts setup --public-url https://hooks.example.com",
      "control-plane/scripts/linear.ts setup --public-url https://hooks.example.com",
      "control-plane/scripts/up.ts",
    ]);
    expect(w.log.join("\n")).toContain("ngrok http 3000");
    expect(w.log).toContain(
      "Check the integrations with: bun run github:status, bun run linear:status",
    );
  });

  it("on kind, asks for the tunnel's URL after k8s:kind and passes it to the setups", async () => {
    const w = world({ answers: ["http://localhost:13000", "https://hooks.example.com/"] });
    await quickstart(["--kind", "--github-app", "--linear", "--no-keychain"], w.deps);
    expect(w.asked).toEqual([
      "Public HTTPS URL of the tunnel: ",
      "Public HTTPS URL of the tunnel: ",
    ]);
    expect(w.log).toContain(
      "Webhooks need a public HTTPS URL: http://localhost:13000 uses http:, not https:",
    );
    expect(w.steps).toEqual([
      "control-plane/scripts/k8s.ts kind --no-keychain",
      "control-plane/scripts/github.ts setup --target devbox.kind.json --public-url https://hooks.example.com --no-keychain",
      "control-plane/scripts/linear.ts setup --target devbox.kind.json --public-url https://hooks.example.com --no-keychain",
      "control-plane/scripts/k8s.ts kind --no-keychain",
    ]);
    expect(w.log).toContain("  bun run k8s:connect --target devbox.kind.json");
  });

  it("on kind, takes --public-url without asking", async () => {
    const w = world({ isTTY: false });
    await quickstart(
      ["--kind", "--no-github-app", "--linear", "--public-url", "https://hooks.example.com"],
      w.deps,
    );
    expect(w.asked).toEqual([]);
    expect(w.steps[1]).toBe(
      "control-plane/scripts/linear.ts setup --target devbox.kind.json --public-url https://hooks.example.com",
    );
  });

  it("on kind without a terminal or a URL, stops before installing anything", async () => {
    const w = world({ isTTY: false });
    await expect(quickstart(["--kind", "--github-app", "--no-linear"], w.deps)).rejects.toThrow(
      "pass --public-url <url>",
    );
    expect(w.steps).toEqual([]);
  });

  it("on kind, an empty answer stops before the setups", async () => {
    const w = world({ answers: [""] });
    await expect(quickstart(["--kind", "--no-github-app", "--linear"], w.deps)).rejects.toThrow(
      "no public URL entered",
    );
    expect(w.steps).toEqual(["control-plane/scripts/k8s.ts kind"]);
  });

  it("refuses a --public-url that is not a public HTTPS URL, before anything runs", async () => {
    const w = world();
    await expect(
      quickstart([...ALL_NO, "--public-url", "https://192.168.1.10"], w.deps),
    ).rejects.toThrow("--public-url: Webhooks need a public HTTPS URL: 192.168.1.10 is a private");
    expect(w.steps).toEqual([]);
  });

  it("on kind, reads which integrations are on from devbox.kind.json", async () => {
    const w = world({
      kindTarget: {
        context: "kind-devbox",
        profile: "k8s-kind-devbox",
        integrations: { linear: { enabled: true, clientId: "client-1" } },
        publicUrl: "https://hooks.example.com",
      },
      // The saved public URL is used, not asked for.
      answers: ["", ""],
    });
    await quickstart(["--kind"], w.deps);
    expect(w.asked).toEqual([
      "Set up the GitHub App? [y/N] ",
      "Linear is already set up. Run its setup again? [Y/n] ",
    ]);
    expect(w.steps).toHaveLength(3);
  });

  it("without a terminal, stops at a missing config and says what to write", async () => {
    const missing = world({ config: null, isTTY: false });
    await expect(quickstart(ALL_NO, missing.deps)).rejects.toThrow(
      "devbox.config.json not found. List the repos",
    );
    expect(existsSync(join(missing.deps.root, "devbox.config.json"))).toBe(false);
  });

  it("with a terminal, writes the missing config from the answers, then goes on", async () => {
    const w = world({ config: null, answers: ["", "frodo/ring", "", "", "anthropic", "", ""] });
    await quickstart(ALL_NO, w.deps);
    expect(JSON.parse(readFileSync(join(w.deps.root, "devbox.config.json"), "utf8"))).toEqual(
      CONFIG_WRITTEN,
    );
    expect(w.log).toContain("  frodo/ring (branch main)");
    expect(w.steps).toEqual(["control-plane/scripts/up.ts"]);
  });

  it("stops when the user would rather write the config", async () => {
    const w = world({ config: null, answers: [false] });
    await expect(quickstart(ALL_NO, w.deps)).rejects.toThrow(ConfigMissing);
    expect(w.steps).toEqual([]);
  });

  it("never rewrites an existing config; reports the example's placeholder", async () => {
    const example = world({
      config: { ...CONFIG, repos: [{ url: "https://github.com/your-org/your-repo.git" }] },
    });
    await expect(quickstart([], example.deps)).rejects.toThrow("your-org/your-repo");
    expect(example.asked).toEqual([]);
  });

  it("stops before starting anything when a tool is missing", async () => {
    const w = world({
      tools: { "openssl version": { code: 127, stdout: "", stderr: "", missing: true } },
    });
    await expect(quickstart(ALL_NO, w.deps)).rejects.toThrow(
      "1 prerequisite(s) missing: fix them, then run bun run quickstart again",
    );
    expect(w.log).toContain("✗ openssl not found: install it");
    expect(w.steps).toEqual([]);
  });

  it("stops at a failed step and says to run it again", async () => {
    const w = world({ codes: [0, 1] });
    const run = quickstart(["--compose", "--github-app", "--no-linear"], w.deps);
    await expect(run).rejects.toThrow(QuickstartError);
    await expect(run).rejects.toThrow(
      "bun run github:setup failed (exit 1). Fix what it reported, then run bun run quickstart again",
    );
    expect(w.steps).toHaveLength(2);
  });
});
