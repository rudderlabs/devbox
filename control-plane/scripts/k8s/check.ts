// `bun run k8s:check --target <file> [--skip-push-check]`:
// the only command that reads Secrets. For every Secret the chart will use, it
// checks the Secret and its keys, then the GitHub token, the LLM key and the
// Linear client secret against their services, and each enabled integration's
// keys. With the GitHub App's devbox-minted tokens, the token checks run on a
// token minted with the key from the App's key Secret (after checking that the
// installation covers the repos). One line per item, never a value: Secrets
// are decoded in memory only. It never saves, removes or prompts.
import { createPrivateKey } from "node:crypto";
import { GithubAppError } from "../../src/githubToken/mint";
import { GithubAppSetupError, mintAppToken } from "../lib/githubApp";
import { isPem, PrivateKeyError } from "../lib/githubAppKey";
import { enabledGithubApp, enabledLinear } from "../lib/integrations";
import { checkLinear } from "../linear/check";
import type { DevboxConfig } from "../up/config";
import { checkGithub, checkLlm, type Fetch, PreflightError } from "../up/preflight";
import { KubeError, kube, NAMESPACE, type Runner } from "./run";
import { existingSecret, GITHUB_APP_SECRET, GITHUB_SECRET, INTEGRATIONS_SECRET } from "./secrets";
import type { Target } from "./target";
import { userValue } from "./values";

export type CheckDeps = {
  cfg: DevboxConfig;
  target: Target;
  targetPath: string;
  runner: Runner;
  fetch: Fetch;
  log: (line: string) => void;
};

const FORBIDDEN =
  "k8s:check needs read access to Secrets in namespace devbox: skip it, or run it with an account that has it";
const NOT_CREATED = "not created yet (k8s:install creates it)";

// Each enabled integration's keys in the integrations Secret.
const INTEGRATION_KEYS = {
  linear: ["LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"],
  slack: ["SLACK_BOT_TOKEN"],
  githubApp: ["GITHUB_WEBHOOK_SECRET"],
} as const;

class Forbidden extends Error {}

// A Secret as read: its decoded keys, or why there are none (`failed` when
// that is a failure, not a skip); `problem` is what secretItem found wrong
// with the key it checked.
type Read = {
  name: string;
  data?: Record<string, string>;
  reason?: string;
  failed?: boolean;
  problem?: string;
};

export async function k8sCheck(deps: CheckDeps, opts: { skipPushCheck: boolean }): Promise<number> {
  const { cfg, target, log } = deps;
  const k = kube(deps.runner, target.context);
  let failed = 0;
  const ok = (what: string) => log(`  ok    ${what}`);
  const skip = (what: string, why: string) => log(`  skip  ${what}: ${why}`);
  const fail = (what: string, why: string) => {
    failed++;
    log(`  FAIL  ${what}: ${why}`);
  };

  async function read(name: string, path: string, owned: boolean): Promise<Read> {
    const args = ["get", "secret", name, "-n", NAMESPACE, "-o", "json"];
    const r = await k.kubectl(args);
    if (/forbidden/i.test(r.stderr)) throw new Forbidden();
    if (/\(NotFound\)/.test(r.stderr)) {
      return owned
        ? { name, reason: NOT_CREATED }
        : { name, reason: `not found (${path}.existingSecret)`, failed: true };
    }
    if (r.code !== 0) {
      throw new KubeError(
        `kubectl get secret ${name} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
    }
    const { data } = JSON.parse(r.stdout) as { data?: Record<string, string> };
    return {
      name,
      data: Object.fromEntries(
        Object.entries(data ?? {}).map(([key, v]) => [
          key,
          Buffer.from(v, "base64").toString("utf8"),
        ]),
      ),
    };
  }

  // Why `key` is unusable, or undefined when it is fine. iron-proxy sends the
  // GitHub token and the LLM key verbatim, so a trailing newline breaks them.
  const keyProblem = (s: Read, key: string, verbatim: boolean): string | undefined => {
    const value = s.data?.[key];
    if (value === undefined) return `no key "${key}"`;
    if (!value) return `key "${key}" is empty`;
    if (verbatim && /[\r\n]$/.test(value)) return `key "${key}" ends with a newline`;
    return undefined;
  };

  // A Secret's line, checking `key` when given (`problem` adds a check of
  // its value); returns the Secret as read.
  async function secretItem(
    secret: { name: string; path: string; owned: boolean },
    key?: { name: string; verbatim: boolean; problem?: (value: string) => string | undefined },
  ): Promise<Read> {
    const s = await read(secret.name, secret.path, secret.owned);
    const what = `Secret ${s.name}`;
    if (!s.data) {
      (s.failed ? fail : skip)(what, s.reason ?? "");
      return s;
    }
    const problem =
      key && (keyProblem(s, key.name, key.verbatim) ?? key.problem?.(s.data[key.name] as string));
    if (problem) fail(what, problem);
    else ok(what);
    return problem ? { ...s, problem } : s;
  }

  // The value a service check needs, or a skip line when there is none.
  const usable = (s: Read, key: string, verbatim: boolean, what: string): string | undefined => {
    if (s.data && !keyProblem(s, key, verbatim)) return s.data[key];
    skip(what, `no usable key "${key}" in Secret ${s.name}`);
    return undefined;
  };

  // A service's refusals, each a FAIL line; anything else stops the run.
  const REFUSALS = [PreflightError, PrivateKeyError, GithubAppSetupError, GithubAppError];
  async function serviceItem(what: string, check: () => Promise<string | undefined>) {
    try {
      const extra = await check();
      ok(extra ? `${what} ${extra}` : what);
    } catch (err) {
      if (!REFUSALS.some((cls) => err instanceof cls)) throw err;
      fail(what, (err as Error).message);
    }
  }

  // Why the App's private key is unusable: it must be a PEM block that parses.
  const pemProblem = (pem: string): string | undefined => {
    try {
      if (isPem(pem)) {
        createPrivateKey(pem);
        return undefined;
      }
    } catch {
      // not a key
    }
    return 'key "private-key" does not hold a PEM private key';
  };

  const values = target.values;
  const integrations = target.integrations ?? {};
  const app = enabledGithubApp(integrations);
  const minting = app?.tokens === "devbox" ? app : undefined;
  const userKeySecret = existingSecret(values, "githubApp");
  const enabled = (Object.keys(INTEGRATION_KEYS) as Array<keyof typeof INTEGRATION_KEYS>).filter(
    (name) => integrations[name]?.enabled,
  );
  // The user's existingSecret, else the installer's name for it.
  const secretOf = (key: string, installerName: string) => {
    const name = existingSecret(values, key);
    return { name: name ?? installerName, path: `secrets.${key}`, owned: !name };
  };

  log(`Checking Secrets in namespace ${NAMESPACE} (context ${target.context})`);
  try {
    const github = await secretItem(secretOf("github", GITHUB_SECRET), {
      name: "token",
      verbatim: true,
    });
    // The App's key Secret: present, with a key that parses.
    const appKey = minting
      ? await secretItem(secretOf("githubApp", GITHUB_APP_SECRET), {
          name: "private-key",
          verbatim: false,
          problem: pemProblem,
        })
      : undefined;
    const llm = await secretItem(secretOf("llm", "devbox-llm"), {
      name: "api-key",
      verbatim: true,
    });
    // The chart reads database.existingSecret only without the bundled Postgres.
    const db = userValue(target, ["database", "existingSecret"]);
    if (userValue(target, ["postgresql", "enabled"]) === false && typeof db === "string" && db) {
      await secretItem(
        { name: db, path: "database", owned: false },
        { name: "DATABASE_URL", verbatim: false },
      );
    }
    // The chart's integrations Secret is optional: used only with one enabled.
    const ints = enabled.length
      ? await secretItem(secretOf("integrations", INTEGRATIONS_SECRET))
      : undefined;

    let token: string | undefined;
    let tokenName: string | undefined;
    if (minting && appKey) {
      // The token Secret holds the minter's latest token; the checks need one
      // minted now with the key, which is what is being checked.
      const pem = appKey.data && !appKey.problem ? appKey.data["private-key"] : undefined;
      if (pem === undefined) {
        skip("GitHub App token", `no usable key "private-key" in Secret ${appKey.name}`);
      } else {
        await serviceItem("GitHub App token", async () => {
          ({ token } = await mintAppToken(minting, pem, cfg.repos, {
            fetch: deps.fetch,
            checkCoverage: true,
            target: deps.targetPath,
            keyFix: userKeySecret
              ? `put the right key in Secret "${userKeySecret}" (key private-key).`
              : `fix the saved key (bun run secrets rm GITHUB_APP_PRIVATE_KEY --target ${deps.targetPath}, then bun run github:setup --target ${deps.targetPath}) and re-run bun run k8s:install --target ${deps.targetPath}.`,
          }));
          return `(minted for installation ${minting.installationId})`;
        });
      }
      tokenName = "the GitHub App's token";
      if (token === undefined) skip("GitHub token", "no GitHub App token to check");
    } else {
      token = usable(github, "token", true, "GitHub token");
    }
    if (token !== undefined) {
      const checked = token;
      await serviceItem("GitHub token", async () => {
        await checkGithub(checked, cfg.repos, deps.fetch, {
          requirePush: !opts.skipPushCheck,
          ...(tokenName ? { tokenName } : {}),
        });
        return undefined;
      });
    }
    const key = usable(llm, "api-key", true, "LLM key");
    if (key !== undefined) {
      await serviceItem("LLM key", async () => {
        await checkLlm(cfg.llm, key, deps.fetch);
        return undefined;
      });
    }
    const linear = enabledLinear(integrations);
    if (linear && ints) {
      const secret = usable(ints, "LINEAR_CLIENT_SECRET", false, "Linear client secret");
      if (secret !== undefined) {
        await serviceItem("Linear client secret", async () => {
          const id = await checkLinear(linear.clientId, secret, deps.fetch);
          return `(devbox acts as ${id.viewerName} in workspace ${id.workspaceName})`;
        });
      }
    }

    if (ints) {
      for (const name of enabled) {
        for (const k of INTEGRATION_KEYS[name]) {
          const what = `Secret ${ints.name}: ${k}`;
          if (!ints.data) skip(what, ints.reason ?? "");
          else {
            const problem = keyProblem(ints, k, false);
            if (problem) fail(what, problem);
            else ok(what);
          }
        }
      }
    }
  } catch (err) {
    if (!(err instanceof Forbidden)) throw err;
    log(FORBIDDEN);
    return 1;
  }

  log(failed ? `${failed} failed.` : "All checks passed.");
  return failed ? 1 : 0;
}
