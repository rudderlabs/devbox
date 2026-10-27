import { describe, expect, it } from "bun:test";
import { fakeTerminal } from "../up/fakeTerminal";
import { CredentialRejected, PreflightError } from "../up/preflight";
import { confirm } from "../up/prompt";
import { type Deployment, guarded, type Keychain, MemoryKeychain } from "./keychain";
import {
  checkWithRetry,
  offerSave,
  peekSecret,
  type Resolved,
  type ResolverDeps,
  resolveSecret,
  SecretError,
  secretNamesFor,
} from "./secrets";

const COMPOSE: Deployment = { kind: "compose" };
const K8S: Deployment = { kind: "k8s", context: "ctx", namespace: "devbox" };

type Calls = { run: string[][]; prompt: string[]; confirm: string[]; log: string[] };

function deps(
  opts: {
    env?: Record<string, string | undefined>;
    keychain?: Keychain | null; // null = --no-keychain
    deployment?: Deployment;
    isTTY?: boolean;
    gh?: { code: number; stdout: string } | "missing";
    answers?: string[];
    // Keystrokes at a yes/no question, answered by the real confirm().
    keys?: string;
    targetPath?: string;
  } = {},
): { deps: ResolverDeps; calls: Calls; keychain: MemoryKeychain } {
  const calls: Calls = { run: [], prompt: [], confirm: [], log: [] };
  const memory = opts.keychain instanceof MemoryKeychain ? opts.keychain : new MemoryKeychain();
  const answers = [...(opts.answers ?? [])];
  return {
    calls,
    keychain: memory,
    deps: {
      env: opts.env ?? {},
      keychain: opts.keychain === null ? undefined : (opts.keychain ?? memory),
      deployment: opts.deployment ?? COMPOSE,
      ...(opts.targetPath === undefined ? {} : { targetPath: opts.targetPath }),
      isTTY: opts.isTTY ?? true,
      prompt: async (q) => {
        calls.prompt.push(q);
        return answers.shift() ?? "";
      },
      confirm: (q, o) => {
        calls.confirm.push(q);
        return confirm(q, o, fakeTerminal(opts.keys ?? "\r").term);
      },
      run: async (cmd) => {
        calls.run.push(cmd);
        if (opts.gh === "missing" || opts.gh === undefined) throw new Error("ENOENT: gh");
        return opts.gh;
      },
      log: (line) => void calls.log.push(line),
    },
  };
}

const none = { run: [], prompt: [], confirm: [], log: [] };
const GH = ["gh", "auth", "token"];
const GH_OK = { code: 0, stdout: "gho_gh\n" };

describe("resolveSecret", () => {
  it("env wins over keychain", async () => {
    const kc = new MemoryKeychain({ "compose/LLM_API_KEY": "sk-saved" });
    const d = deps({ env: { LLM_API_KEY: "sk-env" }, keychain: kc });
    expect(await resolveSecret("LLM_API_KEY", d.deps)).toEqual({
      name: "LLM_API_KEY",
      value: "sk-env",
      source: "env",
    });
    expect(d.calls).toEqual({ ...none, log: ["LLM_API_KEY: from your environment"] });
  });

  it("empty GITHUB_TOKEN in env is kept", async () => {
    const kc = new MemoryKeychain({ "compose/GITHUB_TOKEN": "ghp_saved" });
    const d = deps({ env: { GITHUB_TOKEN: "", LLM_API_KEY: "" }, keychain: kc, gh: GH_OK });
    expect(await resolveSecret("GITHUB_TOKEN", d.deps)).toEqual({
      name: "GITHUB_TOKEN",
      value: "",
      source: "env",
    });
    expect(await resolveSecret("LLM_API_KEY", d.deps)).toEqual({
      name: "LLM_API_KEY",
      value: "",
      source: "env",
    });
    expect(d.calls).toEqual({
      ...none,
      log: ["GITHUB_TOKEN: from your environment", "LLM_API_KEY: from your environment"],
    });
  });

  it("empty LINEAR_CLIENT_SECRET in env falls through", async () => {
    const kc = new MemoryKeychain({ "compose/LINEAR_CLIENT_SECRET": "lin_saved" });
    const d = deps({ env: { LINEAR_CLIENT_SECRET: "", LINEAR_WEBHOOK_SECRET: "" }, keychain: kc });
    expect(await resolveSecret("LINEAR_CLIENT_SECRET", d.deps)).toEqual({
      name: "LINEAR_CLIENT_SECRET",
      value: "lin_saved",
      source: "keychain",
    });
    const p = deps({ env: { LINEAR_WEBHOOK_SECRET: "" }, answers: ["whsec"] });
    expect(await resolveSecret("LINEAR_WEBHOOK_SECRET", p.deps)).toEqual({
      name: "LINEAR_WEBHOOK_SECRET",
      value: "whsec",
      source: "prompt",
    });
    expect(p.calls).toEqual({
      ...none,
      prompt: ["Linear webhook signing secret (input hidden): "],
    });
  });

  it("keychain entry is per deployment", async () => {
    const kc = new MemoryKeychain({
      "compose/LLM_API_KEY": "sk-local",
      "k8s:ctx/devbox/LLM_API_KEY": "sk-cluster",
      "k8s:other/devbox/LLM_API_KEY": "sk-other",
    });
    const compose = deps({ keychain: kc, deployment: COMPOSE });
    const k8s = deps({ keychain: kc, deployment: K8S });
    expect((await resolveSecret("LLM_API_KEY", compose.deps)).value).toBe("sk-local");
    expect(await resolveSecret("LLM_API_KEY", k8s.deps)).toEqual({
      name: "LLM_API_KEY",
      value: "sk-cluster",
      source: "keychain",
    });
    expect(k8s.calls).toEqual({
      ...none,
      log: ["LLM_API_KEY: from the system keychain (k8s:ctx/devbox)"],
    });
  });

  it("gh only for GITHUB_TOKEN", async () => {
    const d = deps({ gh: { code: 0, stdout: "  gho_gh\n" }, answers: ["sk-typed"] });
    expect(await resolveSecret("GITHUB_TOKEN", d.deps)).toEqual({
      name: "GITHUB_TOKEN",
      value: "gho_gh",
      source: "gh",
    });
    expect(await resolveSecret("LLM_API_KEY", d.deps)).toEqual({
      name: "LLM_API_KEY",
      value: "sk-typed",
      source: "prompt",
    });
    expect(d.calls).toEqual({
      ...none,
      run: [GH],
      prompt: ["LLM API key (input hidden): "],
      log: ["GITHUB_TOKEN: from gh"],
    });
  });

  it("prompts for GITHUB_TOKEN when gh is missing, logged out or prints nothing", async () => {
    for (const gh of ["missing", { code: 1, stdout: "" }, { code: 0, stdout: "\n" }] as const) {
      const d = deps({ gh, answers: [" ghp_typed \n"] });
      expect(await resolveSecret("GITHUB_TOKEN", d.deps)).toEqual({
        name: "GITHUB_TOKEN",
        value: "ghp_typed",
        source: "prompt",
      });
      expect(d.calls).toEqual({ ...none, run: [GH], prompt: ["GitHub token (input hidden): "] });
    }
  });

  it("uses each secret's own prompt label", async () => {
    const d = deps({ answers: ["a", "b"] });
    await resolveSecret("LINEAR_CLIENT_SECRET", d.deps);
    await resolveSecret("LINEAR_WEBHOOK_SECRET", d.deps);
    expect(d.calls.prompt).toEqual([
      "Linear client secret (input hidden): ",
      "Linear webhook signing secret (input hidden): ",
    ]);
  });

  it("throws on an empty answer at the prompt", async () => {
    const gh = deps({ answers: ["  "] });
    await expect(resolveSecret("GITHUB_TOKEN", gh.deps)).rejects.toThrow(
      new SecretError(
        "no GitHub token: set GITHUB_TOKEN, log in with `gh auth login`, or enter one at the prompt",
      ),
    );
    const llm = deps({ answers: [""] });
    await expect(resolveSecret("LLM_API_KEY", llm.deps)).rejects.toThrow(
      new SecretError("no LLM API key: set LLM_API_KEY or enter one at the prompt"),
    );
  });

  it("missing without a terminal names the variable and how to save it", async () => {
    const UP = "run `bun run up` once in a terminal to save it in the keychain";
    const cases: Array<[Parameters<typeof resolveSecret>[0], string]> = [
      [
        "GITHUB_TOKEN",
        `no GitHub token: set GITHUB_TOKEN, log in with \`gh auth login\`, or ${UP}`,
      ],
      ["LLM_API_KEY", `no LLM API key: set LLM_API_KEY or ${UP}`],
      ["LINEAR_CLIENT_SECRET", `no Linear client secret: set LINEAR_CLIENT_SECRET or ${UP}`],
      [
        "LINEAR_WEBHOOK_SECRET",
        `no Linear webhook signing secret: set LINEAR_WEBHOOK_SECRET or ${UP}`,
      ],
    ];
    for (const [name, message] of cases) {
      const d = deps({ isTTY: false, gh: "missing" });
      const err = await resolveSecret(name, d.deps).catch((e) => e);
      expect(err).toBeInstanceOf(SecretError);
      expect(err.message).toBe(message);
      expect(d.calls.prompt).toEqual([]);
    }
    // --noPrompt behaves the same with a terminal.
    const np = deps({ isTTY: true });
    await expect(resolveSecret("LLM_API_KEY", np.deps, { noPrompt: true })).rejects.toThrow(
      new SecretError(`no LLM API key: set LLM_API_KEY or ${UP}`),
    );
    expect(np.calls.prompt).toEqual([]);
    // With --no-keychain the keychain is no way out.
    const nk = deps({ isTTY: false, keychain: null });
    await expect(resolveSecret("LLM_API_KEY", nk.deps)).rejects.toThrow(
      new SecretError("no LLM API key: set LLM_API_KEY"),
    );
  });

  it("on k8s the hint names the installer and its target file", async () => {
    const withPath = deps({ isTTY: false, deployment: K8S, targetPath: "devbox.k8s.json" });
    await expect(resolveSecret("LLM_API_KEY", withPath.deps)).rejects.toThrow(
      new SecretError(
        "no LLM API key: set LLM_API_KEY or run `bun run k8s:install --target devbox.k8s.json` once in a terminal to save it in the keychain",
      ),
    );
    const noPath = deps({ isTTY: false, deployment: K8S, gh: "missing" });
    await expect(resolveSecret("GITHUB_TOKEN", noPath.deps)).rejects.toThrow(
      new SecretError(
        "no GitHub token: set GITHUB_TOKEN, log in with `gh auth login`, or run `bun run k8s:install --target <file>` once in a terminal to save it in the keychain",
      ),
    );
    const nk = deps({ isTTY: false, deployment: K8S, targetPath: "t.json", keychain: null });
    await expect(resolveSecret("LLM_API_KEY", nk.deps)).rejects.toThrow(
      new SecretError("no LLM API key: set LLM_API_KEY"),
    );
  });

  it("on kind the hint names k8s:kind, which installs from its own target file", async () => {
    const kind: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
    const d = deps({ isTTY: false, deployment: kind, targetPath: "devbox.kind.json" });
    await expect(resolveSecret("LLM_API_KEY", d.deps)).rejects.toThrow(
      new SecretError(
        "no LLM API key: set LLM_API_KEY or run `bun run k8s:kind` once in a terminal to save it in the keychain",
      ),
    );
  });

  it("a keychain that switched itself off is no way out either", async () => {
    const off: Keychain = {
      disabled: true,
      get: async () => undefined,
      set: async () => {},
      delete: async () => false,
    };
    const d = deps({ isTTY: false, keychain: off });
    await expect(resolveSecret("LLM_API_KEY", d.deps)).rejects.toThrow(
      new SecretError("no LLM API key: set LLM_API_KEY"),
    );
  });

  it("--no-keychain never reads or writes", async () => {
    const kc = new MemoryKeychain({ "compose/LLM_API_KEY": "sk-saved" });
    // The entry exists, but --no-keychain hands the resolver no keychain at all.
    const d = deps({ keychain: null, answers: ["sk-typed"] });
    const r = await resolveSecret("LLM_API_KEY", d.deps);
    expect(r).toEqual({ name: "LLM_API_KEY", value: "sk-typed", source: "prompt" });
    await offerSave(r, d.deps);
    expect(await peekSecret("LLM_API_KEY", d.deps)).toBe("missing");
    expect(d.calls).toEqual({ ...none, prompt: ["LLM API key (input hidden): "] });
    expect(kc.entries()).toEqual({ "compose/LLM_API_KEY": "sk-saved" });
  });
});

describe("offerSave", () => {
  it("prompt then save on yes", async () => {
    const d = deps({ deployment: K8S, answers: ["sk-typed"], keys: "y\r" });
    const r = await resolveSecret("LLM_API_KEY", d.deps);
    await offerSave(r, d.deps);
    expect(d.calls.confirm).toEqual([
      "Save LLM_API_KEY to the system keychain for k8s:ctx/devbox? [Y/n] ",
    ]);
    expect(d.keychain.entries()).toEqual({ "k8s:ctx/devbox/LLM_API_KEY": "sk-typed" });
  });

  it("Enter alone saves", async () => {
    const d = deps({ answers: ["sk-typed"], keys: "\r" });
    await offerSave(await resolveSecret("LLM_API_KEY", d.deps), d.deps);
    expect(d.calls.confirm).toEqual([
      "Save LLM_API_KEY to the system keychain for compose? [Y/n] ",
    ]);
    expect(d.keychain.entries()).toEqual({ "compose/LLM_API_KEY": "sk-typed" });
  });

  it("Ctrl-D saves nothing", async () => {
    const d = deps({ answers: ["sk-typed"], keys: "\u0004" });
    await offerSave(await resolveSecret("LLM_API_KEY", d.deps), d.deps);
    expect(d.calls.confirm).toEqual([
      "Save LLM_API_KEY to the system keychain for compose? [Y/n] ",
    ]);
    expect(d.keychain.entries()).toEqual({});
  });

  it("saves nothing on no", async () => {
    const d = deps({ answers: ["sk-typed"], keys: "n\r" });
    await offerSave(await resolveSecret("LLM_API_KEY", d.deps), d.deps);
    expect(d.calls.confirm).toEqual([
      "Save LLM_API_KEY to the system keychain for compose? [Y/n] ",
    ]);
    expect(d.keychain.entries()).toEqual({});
  });

  it("gh value is never offered for saving", async () => {
    const d = deps({ gh: GH_OK });
    const r = await resolveSecret("GITHUB_TOKEN", d.deps);
    expect(r.source).toBe("gh");
    await offerSave(r, d.deps);
    const e = deps({ env: { LLM_API_KEY: "sk-env" } });
    await offerSave(await resolveSecret("LLM_API_KEY", e.deps), e.deps);
    const k = deps({ keychain: new MemoryKeychain({ "compose/LLM_API_KEY": "sk-saved" }) });
    await offerSave(await resolveSecret("LLM_API_KEY", k.deps), k.deps);
    expect([d.calls.confirm, e.calls.confirm, k.calls.confirm]).toEqual([[], [], []]);
    expect(d.keychain.entries()).toEqual({});
    expect(e.keychain.entries()).toEqual({});
  });

  it("no save offer without a terminal", async () => {
    const d = deps({ isTTY: false });
    const r: Resolved = { name: "LLM_API_KEY", value: "sk-typed", source: "prompt" };
    await offerSave(r, d.deps);
    expect(d.calls).toEqual(none);
    expect(d.keychain.entries()).toEqual({});
  });

  it("no save offer once the keychain turned out to be unavailable", async () => {
    const broken: Keychain = {
      get: async () => {
        throw Object.assign(new Error("libsecret not available"), {
          code: "ERR_SECRETS_PLATFORM_ERROR",
        });
      },
      set: async () => {},
      delete: async () => false,
    };
    const d = deps({ keychain: guarded(broken), answers: ["sk-typed"] });
    const r = await resolveSecret("LLM_API_KEY", d.deps);
    await offerSave(r, d.deps);
    expect(d.calls).toEqual({ ...none, prompt: ["LLM API key (input hidden): "] });
  });
});

describe("source lines", () => {
  it("announces env, keychain and gh sources", async () => {
    const kc = new MemoryKeychain({ "k8s:ctx/devbox/LLM_API_KEY": "sk-saved" });
    const d = deps({
      keychain: kc,
      deployment: K8S,
      env: { LINEAR_CLIENT_SECRET: "lc" },
      gh: GH_OK,
    });
    await resolveSecret("GITHUB_TOKEN", d.deps);
    await resolveSecret("LLM_API_KEY", d.deps);
    await resolveSecret("LINEAR_CLIENT_SECRET", d.deps);
    expect(d.calls.log).toEqual([
      "GITHUB_TOKEN: from gh",
      "LLM_API_KEY: from the system keychain (k8s:ctx/devbox)",
      "LINEAR_CLIENT_SECRET: from your environment",
    ]);
  });

  it("no source line before a prompt", async () => {
    const d = deps({ answers: ["xoxb-typed"], deployment: K8S });
    expect(await resolveSecret("SLACK_BOT_TOKEN", d.deps)).toEqual({
      name: "SLACK_BOT_TOKEN",
      value: "xoxb-typed",
      source: "prompt",
    });
    expect(d.calls).toEqual({ ...none, prompt: ["Slack bot token (input hidden): "] });
  });

  it("an empty env value counts as missing for the Slack and webhook secrets", async () => {
    const d = deps({
      deployment: K8S,
      env: { SLACK_BOT_TOKEN: "", GITHUB_WEBHOOK_SECRET: "" },
      answers: ["xoxb", "whsec"],
    });
    expect((await resolveSecret("SLACK_BOT_TOKEN", d.deps)).source).toBe("prompt");
    expect((await resolveSecret("GITHUB_WEBHOOK_SECRET", d.deps)).source).toBe("prompt");
    expect(d.calls.prompt).toEqual([
      "Slack bot token (input hidden): ",
      "GitHub webhook secret (input hidden): ",
    ]);
  });
});

describe("secretNamesFor", () => {
  it("Compose gets six, k8s seven", () => {
    expect(secretNamesFor(COMPOSE)).toEqual([
      "GITHUB_TOKEN",
      "LLM_API_KEY",
      "LINEAR_CLIENT_SECRET",
      "LINEAR_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
    ]);
    expect(secretNamesFor(K8S)).toEqual([
      "GITHUB_TOKEN",
      "LLM_API_KEY",
      "LINEAR_CLIENT_SECRET",
      "LINEAR_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "SLACK_BOT_TOKEN",
    ]);
  });
});

describe("checkWithRetry", () => {
  const rejected = () =>
    new CredentialRejected("GitHub rejected GITHUB_TOKEN (GET /user returned 401)");

  it("returns the check's result for an accepted value", async () => {
    const d = deps();
    const r: Resolved = { name: "GITHUB_TOKEN", value: "ghp_x", source: "keychain" };
    expect(await checkWithRetry(r, d.deps, async (v) => `ok ${v}`)).toEqual({
      resolved: r,
      result: "ok ghp_x",
    });
    expect(d.calls).toEqual(none);
  });

  it("a rejected keychain value is removed, then asked again until accepted", async () => {
    const kc = new MemoryKeychain({
      "k8s:ctx/devbox/GITHUB_TOKEN": "ghp_old",
      "compose/GITHUB_TOKEN": "ghp_local",
    });
    const d = deps({ keychain: kc, deployment: K8S, gh: GH_OK, answers: ["ghp_new"] });
    const r = await resolveSecret("GITHUB_TOKEN", d.deps);
    const checked: string[] = [];
    const out = await checkWithRetry(r, d.deps, async (v) => {
      checked.push(v);
      if (v === "ghp_old") throw rejected();
      return "identity";
    });
    expect(out).toEqual({
      resolved: { name: "GITHUB_TOKEN", value: "ghp_new", source: "prompt" },
      result: "identity",
    });
    expect(checked).toEqual(["ghp_old", "ghp_new"]);
    expect(kc.entries()).toEqual({ "compose/GITHUB_TOKEN": "ghp_local" });
    expect(d.calls).toEqual({
      ...none,
      prompt: ["GitHub token (input hidden): "],
      log: [
        "GITHUB_TOKEN: from the system keychain (k8s:ctx/devbox)",
        "The saved GITHUB_TOKEN for k8s:ctx/devbox was rejected; removing it",
        "GitHub rejected GITHUB_TOKEN (GET /user returned 401)",
        "Enter GITHUB_TOKEN again, or press Enter on an empty value to exit.",
      ],
    });
    // The new value can then be saved in its place.
    await offerSave(out.resolved, d.deps);
    expect(kc.entries()).toEqual({
      "compose/GITHUB_TOKEN": "ghp_local",
      "k8s:ctx/devbox/GITHUB_TOKEN": "ghp_new",
    });
  });

  it("a rejected typed value is asked again until accepted", async () => {
    const d = deps({ answers: ["sk-bad-1", "sk-bad-2", "sk-good"], gh: "missing" });
    const typed = await resolveSecret("LLM_API_KEY", d.deps);
    expect(typed.value).toBe("sk-bad-1");
    const checked: string[] = [];
    const out = await checkWithRetry(typed, d.deps, async (v) => {
      checked.push(v);
      if (v !== "sk-good") throw new CredentialRejected(`LLM check failed for ${v}`);
      return "ok";
    });
    expect(out).toEqual({
      resolved: { name: "LLM_API_KEY", value: "sk-good", source: "prompt" },
      result: "ok",
    });
    expect(checked).toEqual(["sk-bad-1", "sk-bad-2", "sk-good"]);
    expect(d.calls).toEqual({
      ...none,
      prompt: [
        "LLM API key (input hidden): ",
        "LLM API key (input hidden): ",
        "LLM API key (input hidden): ",
      ],
      log: [
        "LLM check failed for sk-bad-1",
        "Enter LLM_API_KEY again, or press Enter on an empty value to exit.",
        "LLM check failed for sk-bad-2",
        "Enter LLM_API_KEY again, or press Enter on an empty value to exit.",
      ],
    });
  });

  it("an empty answer after a rejection exits naming the secret", async () => {
    const kc = new MemoryKeychain({ "compose/LLM_API_KEY": "sk-old" });
    const d = deps({ keychain: kc, answers: [""] });
    const r = await resolveSecret("LLM_API_KEY", d.deps);
    const run = checkWithRetry(r, d.deps, async () => {
      throw new CredentialRejected("LLM check failed: 401");
    });
    await expect(run).rejects.toThrow(SecretError);
    await expect(run).rejects.toThrow("no LLM API key: set LLM_API_KEY or enter one at the prompt");
    expect(kc.entries()).toEqual({});
    expect(d.calls).toEqual({
      ...none,
      prompt: ["LLM API key (input hidden): "],
      log: [
        "LLM_API_KEY: from the system keychain (compose)",
        "The saved LLM_API_KEY for compose was rejected; removing it",
        "LLM check failed: 401",
        "Enter LLM_API_KEY again, or press Enter on an empty value to exit.",
      ],
    });
  });

  it("no terminal stops after removing a rejected keychain value", async () => {
    const kc = new MemoryKeychain({ "compose/LLM_API_KEY": "sk-old" });
    const d = deps({ keychain: kc, isTTY: false });
    const r = await resolveSecret("LLM_API_KEY", d.deps);
    const err = new CredentialRejected(
      "LLM check failed: POST https://llm.example.com/v1/responses returned 401 (check llm.baseUrl, llm.model and LLM_API_KEY)",
    );
    await expect(
      checkWithRetry(r, d.deps, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(kc.entries()).toEqual({});
    expect(d.calls).toEqual({
      ...none,
      log: [
        "LLM_API_KEY: from the system keychain (compose)",
        "The saved LLM_API_KEY for compose was rejected; removing it",
      ],
    });
  });

  it("a rejected env value stops", async () => {
    const kc = new MemoryKeychain({ "compose/GITHUB_TOKEN": "ghp_saved" });
    const d = deps({ keychain: kc, env: { GITHUB_TOKEN: "ghp_env" }, answers: ["x"] });
    const r = await resolveSecret("GITHUB_TOKEN", d.deps);
    const err = rejected();
    await expect(
      checkWithRetry(r, d.deps, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    const p = deps({ gh: GH_OK });
    const fromGh = await resolveSecret("GITHUB_TOKEN", p.deps);
    await expect(
      checkWithRetry(fromGh, p.deps, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(kc.entries()).toEqual({ "compose/GITHUB_TOKEN": "ghp_saved" });
    expect(d.calls).toEqual({ ...none, log: ["GITHUB_TOKEN: from your environment"] });
    expect(p.calls).toEqual({ ...none, run: [GH], log: ["GITHUB_TOKEN: from gh"] });
  });

  it("other failures of a keychain value are not rejections", async () => {
    const kc = new MemoryKeychain({ "compose/GITHUB_TOKEN": "ghp_saved" });
    const d = deps({ keychain: kc });
    const r = await resolveSecret("GITHUB_TOKEN", d.deps);
    const err = new PreflightError("GitHub rate limit hit");
    await expect(
      checkWithRetry(r, d.deps, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(kc.entries()).toEqual({ "compose/GITHUB_TOKEN": "ghp_saved" });
    expect(d.calls).toEqual({
      ...none,
      log: ["GITHUB_TOKEN: from the system keychain (compose)"],
    });
  });
});

describe("peekSecret", () => {
  it("peek reports env/keychain/missing and never prompts", async () => {
    const kc = new MemoryKeychain({ "compose/LLM_API_KEY": "sk-saved" });
    const d = deps({
      keychain: kc,
      env: { GITHUB_TOKEN: "", LINEAR_CLIENT_SECRET: "" },
      gh: GH_OK,
    });
    expect(await peekSecret("GITHUB_TOKEN", d.deps)).toBe("env");
    expect(await peekSecret("LLM_API_KEY", d.deps)).toBe("keychain");
    expect(await peekSecret("LINEAR_CLIENT_SECRET", d.deps)).toBe("missing");
    expect(await peekSecret("LINEAR_WEBHOOK_SECRET", d.deps)).toBe("missing");
    expect(d.calls).toEqual(none);
  });

  it("reports gh for GITHUB_TOKEN when only `gh auth token` has one", async () => {
    const ok = deps({ gh: GH_OK });
    expect(await peekSecret("GITHUB_TOKEN", ok.deps)).toBe("gh");
    expect(await peekSecret("LLM_API_KEY", ok.deps)).toBe("missing");
    expect(ok.calls).toEqual({ ...none, run: [GH] });
    const saved = deps({
      gh: GH_OK,
      keychain: new MemoryKeychain({ "compose/GITHUB_TOKEN": "ghp_saved" }),
    });
    expect(await peekSecret("GITHUB_TOKEN", saved.deps)).toBe("keychain");
    expect(saved.calls).toEqual(none);
    for (const gh of ["missing", { code: 1, stdout: "" }, { code: 0, stdout: "\n" }] as const) {
      const d = deps({ gh });
      expect(await peekSecret("GITHUB_TOKEN", d.deps)).toBe("missing");
      expect(d.calls).toEqual({ ...none, run: [GH] });
    }
  });

  it("needs only env, keychain, deployment and run", async () => {
    const run = async () => GH_OK;
    expect(
      await peekSecret("GITHUB_TOKEN", { env: {}, keychain: undefined, deployment: COMPOSE, run }),
    ).toBe("gh");
  });
});
