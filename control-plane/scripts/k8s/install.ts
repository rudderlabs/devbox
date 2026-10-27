// `bun run k8s:install`: preflight → namespaces and user
// Secrets → helm upgrade --install with values rendered in memory → the first
// snapshot → an API token and a CLI profile. Re-running it upgrades: config
// changes apply, installer-created Secrets are rewritten (rotation), the
// OpenSandbox server restarts when the sandbox template changed (its chart
// rolls it only on its own config), and a repo change triggers a fresh
// snapshot. It never reads a Secret it does not own: the
// user's own are `k8s:check`'s. When only devbox-integrations changed, it says
// how to restart the control plane. With the GitHub App, GITHUB_TOKEN is not
// used: devbox-minted tokens come from the App's private key (one minted here
// for the checks and the token Secret; the minter takes over), external ones
// live in the user's Secret.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  appIdentity,
  GithubAppSetupError,
  mintAppToken,
  missingKeyMessage,
} from "../lib/githubApp";
import { type PrivateKey, PrivateKeyError, resolvePrivateKey } from "../lib/githubAppKey";
import { type EnabledGithubApp, enabledGithubApp, enabledLinear } from "../lib/integrations";
import type { Keychain } from "../lib/keychain";
import {
  checkWithRetry,
  offerSave,
  type Resolved,
  type ResolverDeps,
  resolveSecret,
} from "../lib/secrets";
import { checkLinear, type LinearIdentity } from "../linear/check";
import { cliConfigPath, ensureCliLogin, parseApiTokenOutput, readCliProfile } from "../up/cliLogin";
import type { DevboxConfig } from "../up/config";
import { checkGithub, checkLlm, type Fetch, type Identity } from "../up/preflight";
import { pickClusterIP } from "./clusterIP";
import { freePort, profileFor } from "./connect";
import {
  checkCluster,
  checkNetworkPolicy,
  checkNodeFits,
  checkNoOtherOpenSandbox,
  checkStorage,
  checkTools,
  requireImageValues,
  requireStorageValues,
} from "./preflight";
import { refreshSnapshot, stamp } from "./refresh";
import {
  type Kube,
  KubeError,
  kube,
  NAMESPACE,
  RELEASE,
  REPO_SNAPSHOTS,
  type Runner,
  SANDBOX_NAMESPACE,
} from "./run";
import {
  existingSecret,
  GITHUB_APP_SECRET,
  GITHUB_SECRET,
  INSTALLER_LABEL,
  INTEGRATIONS_SECRET,
  type IntegrationSecretName,
  secretManifest,
  userSecrets,
} from "./secrets";
import type { Target } from "./target";
import { apiIngressUrl, chartValues, userValue, type Values } from "./values";

export const CHART_PATH = join(import.meta.dir, "..", "..", "..", "deploy", "helm", "devbox");
const FIRST_PORT = 13000;
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 300_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const HEALTH_ATTEMPTS = HEALTH_TIMEOUT_MS / HEALTH_INTERVAL_MS;

export type InstallDeps = {
  runner: Runner;
  cfg: DevboxConfig;
  // The cluster to act on, its CLI profile and chart values (--target).
  target: Target;
  targetPath: string;
  env: Record<string, string | undefined>;
  // The OS keychain; undefined with --no-keychain.
  keychain: Keychain | undefined;
  // Whether stdin is a terminal: prompts and save offers need one.
  isTTY: boolean;
  home: string;
  fetch: Fetch;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  prompt: (question: string) => Promise<string>;
  confirm: ResolverDeps["confirm"];
  // Runs `kubectl port-forward` in the background until stop() is called.
  portForward: (k: Kube, port: number) => Promise<{ stop: () => void }>;
  isPortFree: (port: number) => Promise<boolean>;
  writeFile: (path: string, text: string) => void;
  // A file's text, or undefined when it does not exist.
  readFile: (path: string) => string | undefined;
};

export type InstallOptions = {
  render?: string; // --render <path>
  skipPushCheck: boolean;
  skipLlmCheck: boolean;
  skipLinearCheck: boolean;
  netpol: "auto" | "force" | "skip"; // auto = first install only
  timeout: string; // helm --timeout
};

// The values of the installed release, or undefined on a first install.
async function previousValues(k: Kube): Promise<Values | undefined> {
  const status = await k.helm(["status", RELEASE, "-n", NAMESPACE]);
  if (status.code !== 0) {
    if (/release: not found/.test(status.stderr)) return undefined;
    // Not a first install: guessing one would pick a new iron-proxy address.
    throw new KubeError(
      `helm status ${RELEASE} failed: ${status.stderr.trim() || status.stdout.trim()}`,
    );
  }
  return JSON.parse(
    await k.helmOk(["get", "values", RELEASE, "-n", NAMESPACE, "-o", "json"]),
  ) as Values;
}

async function templateHash(k: Kube): Promise<string | undefined> {
  const r = await k.kubectl([
    "get",
    "configmap",
    "devbox-sandbox-template",
    "-n",
    NAMESPACE,
    "-o",
    "jsonpath={.data}",
  ]);
  return r.code === 0 ? createHash("sha256").update(r.stdout).digest("hex") : undefined;
}

// The control plane Deployment's metadata.generation, or undefined when it
// does not exist or cannot be read (then no restart message, and the install
// goes on). Helm rolling it changes the generation; a Secret it reads changing
// does not.
async function controlPlaneGeneration(k: Kube): Promise<string | undefined> {
  const r = await k.kubectl([
    "get",
    "deploy",
    "devbox-control-plane",
    "-n",
    NAMESPACE,
    "-o",
    "jsonpath={.metadata.generation}",
  ]);
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

// The repos as comparable strings: helm returns values with sorted keys.
const repoKeys = (repos: unknown): string[] =>
  (Array.isArray(repos) ? repos : []).map(
    (r: { url?: unknown; branch?: unknown }) => `${r.url}#${r.branch ?? "main"}`,
  );

// The chart refuses these when it renders, in the same words; refused here,
// they stop before anything is checked or written.
function refuseGithubApp(app: EnabledGithubApp | undefined, values: Values): void {
  if (!app) return;
  const fail = (why: string): never => {
    throw new GithubAppSetupError(`integrations.githubApp.enabled is true: ${why}`);
  };
  const userToken = existingSecret(values, "github");
  if (app.tokens === "devbox") {
    // An empty list would make the minter ask for the whole installation.
    const repos = values.repos;
    if (app.tokenScope !== "installation" && !(Array.isArray(repos) && repos.length > 0)) {
      fail("tokenScope: repos needs at least one entry in repos (or use tokenScope: installation)");
    }
    // The minter writes only a Secret devbox owns, never the user's.
    if (userToken) {
      fail(
        "tokens: devbox writes the token Secret itself: remove secrets.github.existingSecret, or use tokens: external",
      );
    }
  } else if (!userToken) {
    fail(
      "tokens: external needs secrets.github.existingSecret: the Secret your tooling keeps fresh",
    );
  }
}

function namespacesManifest(): string {
  const ns = (name: string) => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name, labels: { "app.kubernetes.io/part-of": "devbox" } },
  });
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [ns(NAMESPACE), ns(SANDBOX_NAMESPACE)],
  });
}

export async function install(
  deps: InstallDeps,
  opts: InstallOptions,
  overlay: Values = {},
): Promise<void> {
  const { cfg, log } = deps;
  const context = deps.target.context;
  const k = kube(deps.runner, context);
  const userClusterIP = userValue(deps.target, ["ironProxy", "clusterIP"]) as string | undefined;
  // Linear is on only with the target file's integrations.linear.enabled:
  // devbox.config.json's block and LINEAR_* in env
  // never count. The whole block goes to the chart, switches included.
  const integrations = deps.target.integrations;
  const linear = enabledLinear(integrations ?? {});
  const app = enabledGithubApp(integrations ?? {});
  refuseGithubApp(app, chartValues(cfg, deps.target.values, {}, overlay));
  // Commits link to the App's bot; git values the user set still win.
  const appCommitIdentity = app ? appIdentity(app.slug, app.botUserId) : undefined;

  if (opts.render) {
    const values = chartValues(
      cfg,
      deps.target.values,
      {
        clusterIP: userClusterIP ?? (await pickClusterIP(k)),
        identity: appCommitIdentity,
        integrations,
      },
      overlay,
    );
    deps.writeFile(
      opts.render,
      `# Generated by bun run k8s:install --render from devbox.config.json and the target file. Contains no secrets.\n${stringify(values)}`,
    );
    log(`wrote ${opts.render}`);
    return;
  }

  log(`[1/7] Checks (context ${context})`);
  await checkTools(deps.runner);
  await checkCluster(k);
  const values0 = chartValues(cfg, deps.target.values, {}, overlay);
  requireStorageValues(values0);
  requireImageValues(values0);

  // The tokens come before the cluster probes: a bad token fails in seconds,
  // a probe can take minutes.
  log("[2/7] Secrets");
  // The user's own Secrets are never read: what they hold
  // shows when the pod starts, or with `k8s:check`.
  const own = {
    github: !existingSecret(values0, "github"),
    llm: !existingSecret(values0, "llm"),
    integrations: !existingSecret(values0, "integrations"),
  };
  const secretDeps: ResolverDeps = {
    env: deps.env,
    keychain: deps.keychain,
    deployment: { kind: "k8s", context, namespace: NAMESPACE },
    targetPath: deps.targetPath,
    isTTY: deps.isTTY,
    prompt: deps.prompt,
    confirm: deps.confirm,
    run: (cmd) => deps.runner(cmd),
    log,
  };
  // A typed value is offered for saving once its own check passed (or right
  // away when it has no check or that check is skipped), so a mistyped one is
  // not saved and an accepted one is not lost to another check failing.
  // With devbox-minted tokens and the user's own key Secret, the key is not
  // read here: the seed job mints the first token, and k8s:check checks it.
  const userAppKey = app?.tokens === "devbox" ? existingSecret(values0, "githubApp") : undefined;
  let githubR = own.github && !app ? await resolveSecret("GITHUB_TOKEN", secretDeps) : undefined;
  let appKey: PrivateKey | undefined;
  if (app?.tokens === "devbox" && !userAppKey) {
    appKey = await resolvePrivateKey(secretDeps);
    if (!appKey) throw new PrivateKeyError(missingKeyMessage(deps.targetPath));
  }
  let llmR = own.llm ? await resolveSecret("LLM_API_KEY", secretDeps) : undefined;
  // Only an enabled integration's secrets, and only for the installer's own
  // devbox-integrations.
  const resolveIf = async (on: boolean | undefined, name: IntegrationSecretName) =>
    on && own.integrations ? await resolveSecret(name, secretDeps) : undefined;
  let linearR: { client: Resolved; webhook: Resolved } | undefined;
  if (linear && own.integrations) {
    linearR = {
      client: await resolveSecret("LINEAR_CLIENT_SECRET", secretDeps),
      webhook: await resolveSecret("LINEAR_WEBHOOK_SECRET", secretDeps),
    };
  }
  const slackR = await resolveIf(integrations?.slack?.enabled, "SLACK_BOT_TOKEN");
  const webhookR = await resolveIf(integrations?.githubApp?.enabled, "GITHUB_WEBHOOK_SECRET");
  // Unchecked: offered now, so a failing GitHub check does not lose them.
  if (llmR && opts.skipLlmCheck) await offerSave(llmR, secretDeps);
  if (linearR && opts.skipLinearCheck) {
    await offerSave(linearR.client, secretDeps);
    await offerSave(linearR.webhook, secretDeps);
  }
  if (slackR) await offerSave(slackR, secretDeps);
  if (webhookR) await offerSave(webhookR, secretDeps);
  // The commit identity is the App's bot, or comes from a token resolved
  // here; otherwise the chart uses `git` from the values or its default.
  let identity: Identity | undefined = appCommitIdentity;
  let minted: { token: string; expiresAt: string } | undefined;
  if (app && appKey) {
    minted = await mintAppToken(app, appKey.pem, cfg.repos, {
      fetch: deps.fetch,
      checkCoverage: true,
      target: deps.targetPath,
    });
    log(`GitHub App ${app.slug}: minted a token for installation ${app.installationId}`);
    await checkGithub(minted.token, cfg.repos, deps.fetch, {
      requirePush: !opts.skipPushCheck,
      tokenName: "the GitHub App's token",
    });
  } else if (userAppKey) {
    log(
      `Skipping the GitHub checks: the App's key is in your Secret "${userAppKey}"; run bun run k8s:check --target ${deps.targetPath} after install`,
    );
  }
  if (githubR) {
    ({ resolved: githubR, result: identity } = await checkWithRetry(githubR, secretDeps, (token) =>
      checkGithub(token, cfg.repos, deps.fetch, { requirePush: !opts.skipPushCheck }),
    ));
    await offerSave(githubR, secretDeps);
  }
  if (opts.skipPushCheck) {
    log(
      "warning: push and pull request checks skipped (--skip-push-check): tasks fail when they push or open a pull request if the token cannot",
    );
  }
  if (opts.skipLlmCheck) log("warning: LLM check skipped (--skip-llm-check)");
  else if (llmR) {
    llmR = (await checkWithRetry(llmR, secretDeps, (key) => checkLlm(cfg.llm, key, deps.fetch)))
      .resolved;
    await offerSave(llmR, secretDeps);
  }
  if (linear) {
    // Only the client secret can be checked here; the webhook secret is
    // offered with it once the app itself is accepted.
    let linearIdentity: LinearIdentity | undefined;
    if (opts.skipLinearCheck) log("warning: Linear check skipped (--skip-linear-check)");
    else if (linearR) {
      ({ resolved: linearR.client, result: linearIdentity } = await checkWithRetry(
        linearR.client,
        secretDeps,
        (secret) => checkLinear(linear.clientId, secret, deps.fetch, { log, sleep: deps.sleep }),
      ));
      await offerSave(linearR.client, secretDeps);
      await offerSave(linearR.webhook, secretDeps);
    }
    if (linearIdentity) {
      log(
        `Linear: devbox acts as ${linearIdentity.viewerName} in workspace ${linearIdentity.workspaceName}`,
      );
    }
  }
  // None for a Secret the user brings, or one the seed job fills.
  const github = minted ?? (githubR ? { token: githubR.value } : undefined);
  const llm = llmR?.value ?? "";
  const integrationSecrets: Partial<Record<IntegrationSecretName, string>> = {};
  for (const r of [linearR?.client, linearR?.webhook, slackR, webhookR]) {
    if (r) integrationSecrets[r.name as IntegrationSecretName] = r.value;
  }

  log("[3/7] Cluster");
  const previous = await previousValues(k);
  const storage = await checkStorage(k, values0);
  log(`StorageClass ${storage.name}: ${storage.provisioner}, ${storage.bindingMode}`);
  if (opts.netpol === "force" || (opts.netpol === "auto" && !previous)) {
    await checkNetworkPolicy(k, { sleep: deps.sleep, suffix: stamp(deps.now()) });
  } else if (opts.netpol === "skip") {
    log(
      "warning: NetworkPolicy check skipped (--skip-netpol-check): sandbox egress is not locked down without a CNI that enforces it",
    );
  }
  await checkNodeFits(k, values0);
  await checkNoOtherOpenSandbox(k);

  const path = cliConfigPath(deps.env, deps.home);
  const profile = profileFor(deps.target);
  // The CLI uses the api Ingress when there is one; a webhooks Ingress leaves
  // it on a port-forward, like no Ingress. A reinstall keeps the profile's
  // local port; a saved Ingress URL is dropped (it may be gone).
  const saved = readCliProfile(path, profile)?.url;
  const url =
    apiIngressUrl(deps.target) ??
    (saved && new URL(saved).hostname === "localhost"
      ? saved
      : `http://localhost:${await freePort(FIRST_PORT, deps.isPortFree)}`);

  log("[4/7] Namespaces and Secrets");
  await k.kubectlOk(["apply", "-f", "-"], { stdin: namespacesManifest() });
  if (userAppKey) {
    // The minter may only update its token Secret, so it must exist. Created
    // empty when missing; an existing one is left as it is (create never
    // replaces), so no token is ever read or overwritten here.
    const r = await k.kubectl(["create", "-f", "-"], {
      stdin: secretManifest({ name: GITHUB_SECRET, data: { token: "" } }),
    });
    if (r.code !== 0 && !/\(AlreadyExists\)/.test(r.stderr)) {
      throw new KubeError(
        `kubectl create secret ${GITHUB_SECRET} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
    }
    log("The token Secret is filled by the devbox-github-token-seed job");
  }
  const secrets = userSecrets(values0, {
    github,
    githubApp: appKey && { pem: appKey.pem },
    llm,
    integrations: integrationSecrets,
  });
  // kubectl says "configured" only when the Secret's data changed.
  let integrationsChanged = false;
  for (const s of secrets) {
    const out = await k.kubectlOk(["apply", "-f", "-"], { stdin: secretManifest(s) });
    if (s.name === INTEGRATIONS_SECRET) {
      integrationsChanged = /^secret\/devbox-integrations configured$/m.test(out);
    }
  }
  // An installer-owned Secret this install does not use goes; the user's own
  // (no installer label) is never touched.
  const deleteOwned = async (name: string, why?: string) => {
    const out = await k.kubectlOk([
      "delete",
      "secret",
      "-n",
      NAMESPACE,
      "-l",
      INSTALLER_LABEL,
      "--field-selector",
      `metadata.name=${name}`,
      "--ignore-not-found",
    ]);
    if (why && /deleted/.test(out)) log(`Deleted Secret ${name}: ${why}`);
  };
  // devbox-integrations with nothing left to hold (linear:disable relies on it).
  if (own.integrations && !secrets.some((s) => s.name === INTEGRATIONS_SECRET)) {
    await deleteOwned(INTEGRATIONS_SECRET);
  }
  // No unused copy of the App's private key stays in the cluster: the App
  // is off, its key is in the user's Secret, or its tokens are external.
  if (!appKey) {
    await deleteOwned(
      GITHUB_APP_SECRET,
      "this install does not use the installer's copy of the GitHub App's private key",
    );
  }
  // External tokens live in the user's Secret; a token the installer wrote
  // before is stale.
  if (app?.tokens === "external") {
    await deleteOwned(
      GITHUB_SECRET,
      `with external tokens the token comes from Secret "${existingSecret(values0, "github")}"`,
    );
  }

  log("[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)");
  const clusterIP =
    userClusterIP ??
    ((previous?.ironProxy as Values | undefined)?.clusterIP as string | undefined) ??
    (await pickClusterIP(k));
  const values = chartValues(
    cfg,
    deps.target.values,
    { clusterIP, publicBaseUrl: url, identity, integrations },
    overlay,
  );
  const before = await templateHash(k);
  const generationBefore = previous ? await controlPlaneGeneration(k) : undefined;
  const helm = await k.helm(
    [
      "upgrade",
      "--install",
      RELEASE,
      CHART_PATH,
      "-n",
      NAMESPACE,
      "-f",
      "-",
      "--wait",
      "--timeout",
      opts.timeout,
    ],
    { stdin: JSON.stringify(values) },
  );
  if (helm.code !== 0) {
    if (/clusterIPs?.*(not in the valid range|already allocated)/.test(helm.stderr)) {
      throw new KubeError(
        `the API server rejected iron-proxy's address ${clusterIP}: set values.ironProxy.clusterIP in the target file to a free address in the Service range (docs/kubernetes/README.md#iron-proxy-address)\n${helm.stderr.trim()}`,
      );
    }
    // Show the hooks' own errors: the bootstrap hook runs on every install
    // and upgrade, the snapshot builder's only on a first install (its Job is
    // deleted ten minutes after it fails, so pointing at it is not enough).
    const logs = async (job: string, ns: string, title: string) => {
      const r = await k.kubectl(["logs", `job/${job}`, "-n", ns, "--tail=50"]);
      return r.code === 0 && r.stdout.trim() ? `\n\n${title} logs:\n${r.stdout.trim()}` : "";
    };
    const bootstrapLogs = await logs("devbox-bootstrap", NAMESPACE, "bootstrap");
    const builderLogs = previous
      ? ""
      : await logs("devbox-snapshot-builder-install", SANDBOX_NAMESPACE, "snapshot builder");
    throw new KubeError(
      `helm upgrade --install failed:\n${helm.stderr.trim() || helm.stdout.trim()}${bootstrapLogs}${builderLogs}`,
    );
  }
  const after = await templateHash(k);
  const generationAfter = previous ? await controlPlaneGeneration(k) : undefined;
  if (previous && before !== after) {
    log("sandbox template changed: restarting the OpenSandbox server");
    await k.kubectlOk(["rollout", "restart", "deployment/opensandbox-server", "-n", NAMESPACE]);
    await k.kubectlOk([
      "rollout",
      "status",
      "deployment/opensandbox-server",
      "-n",
      NAMESPACE,
      "--timeout=5m",
    ]);
  }

  // Helm did not roll the control plane, so it still runs with the old values.
  if (integrationsChanged && generationBefore && generationBefore === generationAfter) {
    log(`The integrations secrets changed; the control plane keeps the old values until it restarts:
  kubectl --context ${context} -n ${NAMESPACE} rollout restart deploy/devbox-control-plane
then: bun run k8s:check --target ${deps.targetPath}`);
  }

  log("[6/7] Repo snapshot");
  if (previous && repoKeys(previous.repos).join("\n") !== repoKeys(values.repos).join("\n")) {
    log("repos changed: building a fresh snapshot");
    await refreshSnapshot(k, { sleep: deps.sleep, log, now: deps.now });
  }
  const readySnapshots = async () =>
    (
      await k.kubectlOk([
        "get",
        "volumesnapshot",
        "-n",
        SANDBOX_NAMESPACE,
        "-l",
        REPO_SNAPSHOTS,
        "-o",
        'jsonpath={range .items[?(@.status.readyToUse==true)]}{.metadata.name}{"\\n"}{end}',
      ])
    ).trim();
  let ready = await readySnapshots();
  // A failed first install leaves the release in place, so the next run is an
  // upgrade and the post-install hook does not run again: build it here.
  if (!ready && previous) {
    log("no ready repo snapshot: building one");
    await refreshSnapshot(k, { sleep: deps.sleep, log, now: deps.now });
    ready = await readySnapshots();
  }
  if (!ready) {
    throw new KubeError(
      `no ready repo snapshot: run \`bun run k8s:refresh-snapshot --target ${deps.targetPath}\` and read its output`,
    );
  }

  log("[7/7] CLI login");
  const local = new URL(url).hostname === "localhost";
  // Before an API token exists: a VPN-only Ingress is unreachable from here.
  if (!local) {
    let cause = "no answer";
    let up = false;
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS && !up; attempt++) {
      if (attempt > 0) await deps.sleep(HEALTH_INTERVAL_MS);
      try {
        const res = await deps.fetch(`${url}/health`, {
          signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        });
        up = res.ok;
        if (!up) cause = `HTTP ${res.status}`;
      } catch (e) {
        cause = e instanceof Error ? e.message : String(e);
      }
      if (!up && attempt === 0) log(`waiting for ${url}/health`);
    }
    if (!up) {
      throw new KubeError(
        `cannot reach ${url}/health after ${HEALTH_TIMEOUT_MS / 60_000} minutes (${cause}). The load balancer, DNS or certificate may still be provisioning: wait and run again. If the api Ingress is internal (VPN), connect this machine to it first. The chart is installed, only the CLI login is left.`,
      );
    }
  }
  const forward = local ? await localForward(deps, k, Number(new URL(url).port)) : undefined;
  try {
    const outcome = await ensureCliLogin({
      path,
      profile,
      url,
      isValid: async (p) => {
        try {
          const res = await deps.fetch(`${url}/api/me`, {
            headers: { Authorization: `Bearer ${p.token}` },
          });
          return res.ok;
        } catch {
          return false;
        }
      },
      // stdout holds the token: never print it.
      createToken: async () =>
        parseApiTokenOutput(
          await k.kubectlOk([
            "exec",
            "-n",
            NAMESPACE,
            "deploy/devbox-control-plane",
            "--",
            "bun",
            "run",
            "api-token",
            "create",
            `devbox-cli-${stamp(deps.now())}`,
          ]),
        ),
    });
    log(
      outcome === "kept"
        ? `CLI profile "${profile}" is still valid`
        : `CLI logged in: profile "${profile}" in ${path}`,
    );
  } finally {
    forward?.stop();
  }

  log(`
devbox is installed in context ${context}. The CLI uses profile "${profile}".
${local ? `\n  bun run k8s:connect --target ${deps.targetPath}     # keep it running in another terminal` : ""}
  bun run devbox create "Add a /health endpoint to ${cfg.repos[0]?.owner}/${cfg.repos[0]?.name}"
  bun run devbox logs -f <task>${linear ? `\n\nCheck Linear with: bun run linear:status --target ${deps.targetPath}` : ""}`);
}

// A running `k8s:connect` already holds the profile's port: use it.
async function localForward(
  deps: InstallDeps,
  k: Kube,
  port: number,
): Promise<{ stop: () => void } | undefined> {
  if (await deps.isPortFree(port)) return deps.portForward(k, port);
  deps.log(`port ${port} is in use (by \`bun run k8s:connect\`?): logging in through it`);
  return undefined;
}
