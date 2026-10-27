// `bun run up`: starts the local devbox stack from devbox.config.json and
// logs the CLI in. It coordinates the existing scripts rather than rewriting
// them. Secrets (LLM_API_KEY; GITHUB_TOKEN, or with the GitHub App
// GITHUB_WEBHOOK_SECRET and, for devbox-minted tokens, the App's private key;
// LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET when devbox.config.json has
// `integrations.linear.enabled: true`) come from the environment, then the OS
// keychain's Compose entries, then `gh auth token` for GITHUB_TOKEN, then a
// hidden prompt (scripts/lib/secrets.ts; the private key is never prompted
// for, scripts/lib/githubAppKey.ts). A typed value may be saved in the
// keychain once its own check passes. Secrets reach only the keychain and the
// environment of the child processes that need them; no file holds one (the
// CLI config file holds the CLI's own API token).
//
// GitHub has three modes. Without `integrations.githubApp` (or with it
// disabled), GITHUB_TOKEN is the token, as before. With the App and
// `tokens: "devbox"`, `up` mints a token for its checks and the repos volume,
// and Compose runs the token minter (profile github-app) that keeps a fresh
// token on a shared volume. With `tokens: "external"`, the user's own tooling
// keeps `tokenFile` fresh and its directory is mounted. Both App modes turn on
// GitHub webhooks and commit as the App's bot.
//
// Linear is on only with `integrations.linear.enabled: true`: Compose then
// gets LINEAR_ENABLED=true, the client ID and both secrets, and otherwise all
// four empty, so a LINEAR_* variable left in the shell never turns it on.
//
// --skip-checks skips the GitHub, LLM and Linear checks before startup, for
// offline verification and development.
//
// --no-keychain never reads or writes the keychain.
//
// --dns-resolver <host:port> sets the resolver iron-proxy uses for its own
// lookups (default 1.1.1.1:53): Docker's DNS would resolve the aliased hosts
// back to the proxy, and some networks block public resolvers.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { capture } from "./lib/capture";
import {
  appIdentity,
  appRepositories,
  mintAppToken,
  missingKeyMessage,
  readTokenFile,
} from "./lib/githubApp";
import { type PrivateKey, resolvePrivateKey } from "./lib/githubAppKey";
import {
  type EnabledGithubApp,
  enabledGithubApp,
  enabledLinear,
  type LinearIntegration,
} from "./lib/integrations";
import { keychainFor } from "./lib/keychain";
import { errorMessage, isKnownError } from "./lib/knownError";
import {
  checkWithRetry,
  offerSave,
  type Resolved,
  type ResolverDeps,
  resolveSecret,
} from "./lib/secrets";
import { checkLinear, type LinearIdentity } from "./linear/check";
import { bunVersionError } from "./up/bunVersion";
import { cliConfigPath, ensureCliLogin, parseApiTokenOutput } from "./up/cliLogin";
import { type ComposeDevboxConfig, type DevboxConfig, LLM_STAGES, loadConfig } from "./up/config";
import {
  DEFAULT_DNS_RESOLVER,
  DNS_RESOLVER,
  GITHUB_TOKEN_FILE,
  llmHost,
  OUTPUT_PATH,
  renderIronProxyConfig,
  TEMPLATE_PATH,
} from "./up/ironProxy";
import { readOrCreateKey } from "./up/localKey";
import { checkGithub, checkLlm, type Fetch, type Identity } from "./up/preflight";
import { confirm, promptHidden } from "./up/prompt";

const CP = join(import.meta.dir, "..");
const ROOT = join(CP, "..");
const CONFIG_PATH = join(ROOT, "devbox.config.json");
const COMPOSE = ["docker", "compose", "-f", join(CP, "docker-compose.yml")];
const CA = join(CP, "infra", "local", "certs", "ca.crt");
const OPENSANDBOX_KEY = join(CP, "infra", "local", "opensandbox.key");
const API_URL = "http://localhost:3000";
const HEALTH_TIMEOUT_MS = 180_000;
const DOCKER_INFO_TIMEOUT_MS = 20_000;
// Measured on a cold Docker cache (Apple M-series, fast network); see README.
const FIRST_BUILD = "about 10 minutes";

class UpError extends Error {}

const log = (line: string) => process.stdout.write(`${line}\n`);
const step = (n: number, what: string) => log(`\n[${n}/8] ${what}`);

export type Env = Record<string, string | undefined>;

type LinearSecrets = { clientSecret: string; webhookSecret: string };
type LinearEnvName =
  | "LINEAR_ENABLED"
  | "LINEAR_CLIENT_ID"
  | "LINEAR_CLIENT_SECRET"
  | "LINEAR_WEBHOOK_SECRET";

// The Linear values for Compose: all four empty unless `integrations.linear`
// is enabled, whatever the shell or the secrets say.
export function linearComposeEnv(
  linear: LinearIntegration | undefined,
  secrets?: LinearSecrets,
): Record<LinearEnvName, string> {
  const on = enabledLinear({ linear });
  if (!on) {
    return {
      LINEAR_ENABLED: "",
      LINEAR_CLIENT_ID: "",
      LINEAR_CLIENT_SECRET: "",
      LINEAR_WEBHOOK_SECRET: "",
    };
  }
  if (!secrets) {
    throw new Error("integrations.linear is enabled but the Linear secrets were not resolved");
  }
  return {
    LINEAR_ENABLED: "true",
    LINEAR_CLIENT_ID: on.clientId,
    LINEAR_CLIENT_SECRET: secrets.clientSecret,
    LINEAR_WEBHOOK_SECRET: secrets.webhookSecret,
  };
}

type GithubAppSecrets = { webhookSecret?: string; pem?: string };

// Where the token directory is mounted in the control plane and iron-proxy.
const TOKEN_DIR = dirname(GITHUB_TOKEN_FILE);

// The token file inside the containers: the minter's, or (external tokens)
// the user's file under the mounted directory.
const containerTokenFile = (app: EnabledGithubApp): string =>
  app.tokens === "external" && app.tokenFile
    ? `${TOKEN_DIR}/${basename(app.tokenFile)}`
    : GITHUB_TOKEN_FILE;

// The GitHub values for Compose. Every key is always set (empty when unused),
// so a value left in the shell never reaches a container. With the App,
// GITHUB_TOKEN is empty: the token comes from the token file.
export function githubComposeEnv(
  app: EnabledGithubApp | undefined,
  cfg: DevboxConfig,
  secrets: GithubAppSecrets,
): Env {
  const trust = {
    GITHUB_TRUSTED_ORGS: cfg.github.trustedOrgs.join(","),
    GITHUB_TRUSTED_USERS: cfg.github.trustedUsers.join(","),
  };
  const off = {
    GITHUB_TOKEN_FILE: "",
    GITHUB_TOKEN_DIR: "",
    GITHUB_APP_ID: "",
    GITHUB_APP_INSTALLATION_ID: "",
    GITHUB_APP_REPOSITORIES: "",
    GITHUB_APP_PRIVATE_KEY: "",
    GITHUB_WEBHOOKS_ENABLED: "",
    GITHUB_WEBHOOK_SECRET: "",
    GITHUB_BOT_LOGIN: "",
    GITHUB_BOT_USER_ID: "",
    GITHUB_CI_RESULT_ENABLED: "",
  };
  if (!app) return { ...off, ...trust };
  if (!secrets.webhookSecret) {
    throw new Error("integrations.githubApp is enabled but GITHUB_WEBHOOK_SECRET was not resolved");
  }
  const webhooks = {
    GITHUB_WEBHOOKS_ENABLED: "true",
    GITHUB_WEBHOOK_SECRET: secrets.webhookSecret,
    GITHUB_BOT_LOGIN: app.slug,
    GITHUB_BOT_USER_ID: String(app.botUserId),
    GITHUB_CI_RESULT_ENABLED: String(app.ciResults),
  };
  const token = { GITHUB_TOKEN: "", GITHUB_TOKEN_FILE: containerTokenFile(app) };
  if (app.tokens === "external") {
    return {
      ...off,
      ...webhooks,
      ...trust,
      ...token,
      GITHUB_TOKEN_DIR: app.tokenFile ? dirname(app.tokenFile) : "",
    };
  }
  if (!secrets.pem) {
    throw new Error(
      "integrations.githubApp is enabled but the GitHub App's private key was not resolved",
    );
  }
  return {
    ...off,
    ...webhooks,
    ...trust,
    ...token,
    GITHUB_APP_ID: String(app.appId),
    GITHUB_APP_INSTALLATION_ID: String(app.installationId),
    GITHUB_APP_REPOSITORIES: app.tokenScope === "repos" ? appRepositories(cfg.repos).join(",") : "",
    GITHUB_APP_PRIVATE_KEY: secrets.pem,
  };
}

// The Compose profiles to start: the token minter for devbox-minted tokens.
export const composeProfiles = (app: EnabledGithubApp | undefined): string[] =>
  app?.tokens === "devbox" ? ["github-app"] : [];

export type ComposeStep = { cmd: string[]; ignore?: RegExp };

// The Compose commands that start the stack. Devbox-minted: the minter's
// first token goes on the shared volume before the control plane and
// iron-proxy start (the run exits non-zero if GitHub refuses), then startup
// with the profile, then the minter restarted with the current key.
// Otherwise a minter left from an earlier devbox-minted run is stopped and
// removed first, as a plain `up` would leave it running. In every mode,
// iron-proxy is recreated because it reads its bind-mounted config only once
// and Compose does not detect changes to the file's contents.
export function composeStartSteps(
  app: EnabledGithubApp | undefined,
  compose: string[] = COMPOSE,
): ComposeStep[] {
  const profile = ["--profile", "github-app"];
  if (composeProfiles(app).length > 0) {
    return [
      {
        cmd: [
          ...compose,
          ...profile,
          "run",
          "--rm",
          "--build",
          "github-token",
          "bun",
          "run",
          "github-token",
          "--once",
        ],
      },
      { cmd: [...compose, ...profile, "up", "-d", "--build"] },
      // Compose doesn't see a new private key (a secret's value isn't part of
      // the service's config), so the running minter is always recreated.
      {
        cmd: [...compose, ...profile, "up", "-d", "--force-recreate", "--no-deps", "github-token"],
      },
      {
        cmd: [...compose, ...profile, "up", "-d", "--force-recreate", "--no-deps", "iron-proxy"],
      },
    ];
  }
  return [
    {
      cmd: [...compose, ...profile, "rm", "-sf", "github-token"],
      ignore: /no such (service|container)/i,
    },
    { cmd: [...compose, "up", "-d", "--build"] },
    { cmd: [...compose, "up", "-d", "--force-recreate", "--no-deps", "iron-proxy"] },
  ];
}

// Where iron-proxy reads the GitHub token: GITHUB_TOKEN for a personal token,
// the token file in both App modes.
export const ironProxyTokenOptions = (
  app: EnabledGithubApp | undefined,
): { githubTokenSource: "env" | "file"; githubTokenFile?: string } =>
  app
    ? { githubTokenSource: "file", githubTokenFile: containerTokenFile(app) }
    : { githubTokenSource: "env" };

type LlmComposeEnvName =
  | "HARNESS_REASONING_EFFORT"
  | `HARNESS_${(typeof LLM_STAGES)[keyof typeof LLM_STAGES]}_${"MODEL" | "REASONING_EFFORT"}`;

// Every model setting is present, empty when unset, so a value exported in the
// user's shell cannot leak into the control plane.
export function llmComposeEnv(cfg: DevboxConfig["llm"]): Record<LlmComposeEnvName, string> {
  const env = { HARNESS_REASONING_EFFORT: cfg.reasoningEffort ?? "" } as Record<
    LlmComposeEnvName,
    string
  >;
  for (const [stage, envStage] of Object.entries(LLM_STAGES)) {
    const setting = cfg.stages?.[stage as keyof typeof LLM_STAGES];
    env[`HARNESS_${envStage}_MODEL`] = setting?.model ?? "";
    env[`HARNESS_${envStage}_REASONING_EFFORT`] = setting?.reasoningEffort ?? "";
  }
  return env;
}

// The LLM part of the config line `up` prints, with any effort and stage
// overrides and their values.
export function llmSummary(cfg: DevboxConfig["llm"]): string {
  const reasoning = cfg.reasoningEffort ? `, reasoning ${cfg.reasoningEffort}` : "";
  const overrides = Object.entries(cfg.stages ?? {}).flatMap(([stage, setting]) =>
    Object.entries(setting).map(([field, value]) => `${stage}.${field}=${value}`),
  );
  const stages = overrides.length > 0 ? `, stage overrides: ${overrides.join(", ")}` : "";
  return `provider ${cfg.provider}, model ${cfg.model} at ${cfg.baseUrl}${reasoning}${stages}`;
}

// The environment `docker compose` runs with. Config-derived values go after
// the shell, so a shell value never overrides them.
export function composeEnvFor(
  base: Env,
  cfg: ComposeDevboxConfig,
  values: {
    github: string;
    llm: string;
    opensandboxKey: string;
    linear?: LinearSecrets;
    githubApp?: GithubAppSecrets;
  },
): Env {
  return {
    ...base,
    MAX_CONCURRENT_SANDBOXES: String(cfg.sandbox.maxConcurrent),
    SANDBOX_RESOURCE_CPU: cfg.sandbox.cpu,
    SANDBOX_RESOURCE_MEMORY: cfg.sandbox.memory,
    // The control plane requires a GitHub token at startup; without one (only
    // possible with --skip-checks) it gets a placeholder GitHub rejects.
    GITHUB_TOKEN: values.github || "no-github-token",
    LLM_API_KEY: values.llm,
    OPENSANDBOX_API_KEY: values.opensandboxKey,
    IRON_PROXY_LLM_HOST: llmHost(cfg.llm.baseUrl),
    HARNESS_LLM_PROVIDER: cfg.llm.provider,
    HARNESS_LLM_BASE_URL: cfg.llm.baseUrl,
    HARNESS_MODEL: cfg.llm.model,
    ...llmComposeEnv(cfg.llm),
    ...linearComposeEnv(cfg.integrations.linear, values.linear),
    ...githubComposeEnv(enabledGithubApp(cfg.integrations), cfg, values.githubApp ?? {}),
  };
}

// Runs a command with inherited output; throws on a non-zero exit.
async function run(cmd: string[], opts: { env?: Env; stdin?: string } = {}): Promise<void> {
  const proc = Bun.spawn(cmd, {
    env: opts.env ?? process.env,
    stdin: opts.stdin === undefined ? "inherit" : new Blob([opts.stdin]),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new UpError(`${cmd.slice(0, 3).join(" ")} … exited with ${code}`);
}

// 1. Prerequisites. The config file is checked before Docker is touched.
async function prerequisites(): Promise<ComposeDevboxConfig> {
  const tooOld = bunVersionError(Bun.version);
  if (tooOld) throw new UpError(tooOld);
  const cfg = loadConfig(CONFIG_PATH);
  let docker: Awaited<ReturnType<typeof capture>>;
  try {
    docker = await capture(["docker", "info", "--format", "{{.ServerVersion}}"], {
      env: process.env,
      timeoutMs: DOCKER_INFO_TIMEOUT_MS,
    });
  } catch {
    throw new UpError(
      "docker not found: install Docker (Docker Desktop, or Docker Engine on Linux)",
    );
  }
  if (docker.timedOut) {
    throw new UpError(
      `the Docker daemon did not answer within ${DOCKER_INFO_TIMEOUT_MS / 1000} seconds. ` +
        "If Docker Desktop is starting, wait for it; if it is stuck, restart it. " +
        "Check with `docker info`, then run `bun run up` again",
    );
  }
  if (docker.code !== 0) {
    if (/permission denied/i.test(docker.stderr)) {
      throw new UpError(
        "cannot reach the Docker daemon: permission denied. Add yourself to the docker group " +
          "(sudo usermod -aG docker $USER), then log out and back in",
      );
    }
    throw new UpError(
      `cannot reach the Docker daemon: ${docker.stderr.trim() || "is it running?"}`,
    );
  }
  return cfg;
}

// 4. Local keys: the iron-proxy CA and the OpenSandbox API key, both
// local-only random values kept under infra/local/ (gitignored).
async function localKeys(): Promise<string> {
  await run(["bash", join(CP, "scripts", "gen-iron-proxy-ca.sh")]);
  return readOrCreateKey(OPENSANDBOX_KEY, () => randomBytes(24).toString("hex"));
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(2000);
  }
  throw new UpError(
    `the control plane did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s; see: docker compose -f control-plane/docker-compose.yml logs control-plane`,
  );
}

async function tokenIsValid(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok;
  } catch {
    return false;
  }
}

async function createToken(composeEnv: Env): Promise<string> {
  const name = `devbox-cli-${new Date().toISOString().replace(/[-:]|\.\d+Z$/g, "")}`;
  const res = await capture(
    [...COMPOSE, "exec", "-T", "control-plane", "bun", "run", "api-token", "create", name],
    { env: composeEnv },
  );
  // stdout holds the token: never print it.
  if (res.code !== 0) {
    throw new UpError(`creating a CLI API token failed: ${res.stderr.trim()}`);
  }
  return parseApiTokenOutput(res.stdout);
}

// The GitHub App's token for the checks and the repos volume. Devbox-minted:
// first, unless --skip-checks, that the installation covers every repo
// (a token narrowed to a repo outside it is refused as a whole), then one
// token minted here; the minter mints its own. External: the token file, read
// once. Then the same repo checks as for a personal token.
export async function appToken(
  app: EnabledGithubApp,
  cfg: DevboxConfig,
  key: PrivateKey | undefined,
  deps: ResolverDeps,
  opts: { skipChecks: boolean; fetch: Fetch },
): Promise<string> {
  const { skipChecks, fetch } = opts;
  let token: string;
  let tokenName: string;
  if (app.tokens === "external") {
    token = readTokenFile(app.tokenFile ?? "");
    tokenName = `the token in ${app.tokenFile}`;
    deps.log(`GitHub App ${app.slug}: token from ${app.tokenFile}`);
  } else {
    if (!key) throw new UpError("the GitHub App's private key was not resolved");
    ({ token } = await mintAppToken(app, key.pem, cfg.repos, {
      fetch,
      checkCoverage: !skipChecks,
    }));
    tokenName = "the GitHub App's token";
    deps.log(`GitHub App ${app.slug}: minted a token for installation ${app.installationId}`);
  }
  if (!skipChecks) await checkGithub(token, cfg.repos, fetch, { tokenName });
  return token;
}

export async function up(argv: string[], env: Env = process.env): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "skip-checks": { type: "boolean" },
      "dns-resolver": { type: "string" },
      "no-keychain": { type: "boolean" },
    },
    allowPositionals: false,
  });
  const skipChecks = values["skip-checks"] === true;
  const dnsResolver = values["dns-resolver"] ?? DEFAULT_DNS_RESOLVER;
  if (!DNS_RESOLVER.test(dnsResolver)) {
    throw new UpError(
      `--dns-resolver: must be "<host>:<port>", got ${JSON.stringify(dnsResolver)}`,
    );
  }

  step(1, "Prerequisites");
  const cfg = await prerequisites();
  log(
    `${relative(process.cwd(), CONFIG_PATH) || CONFIG_PATH}: ${cfg.repos.length} repo(s), ${llmSummary(cfg.llm)}`,
  );

  step(2, "Secrets");
  const secretDeps: ResolverDeps = {
    env,
    keychain: keychainFor(values["no-keychain"]),
    deployment: { kind: "compose" },
    isTTY: process.stdin.isTTY === true,
    prompt: promptHidden,
    confirm,
    run: (cmd: string[]) => capture(cmd),
    log,
  };
  // With the GitHub App there is no GITHUB_TOKEN to resolve: the token is
  // minted (devbox) or read from tokenFile (external).
  const app = enabledGithubApp(cfg.integrations);
  let gh:
    | { app: undefined; token: Resolved }
    | { app: EnabledGithubApp; webhook: Resolved; key?: PrivateKey };
  if (!app) {
    gh = { app, token: await resolveSecret("GITHUB_TOKEN", secretDeps) };
  } else {
    gh = { app, webhook: await resolveSecret("GITHUB_WEBHOOK_SECRET", secretDeps) };
    if (app.tokens === "devbox") {
      gh.key = await resolvePrivateKey(secretDeps);
      if (!gh.key) {
        throw new UpError(missingKeyMessage());
      }
    }
  }
  let llmR = await resolveSecret("LLM_API_KEY", secretDeps);
  // Both Linear secrets, only when Linear is enabled (with a terminal they are
  // asked for; without one `up` fails naming the variable).
  const linear = enabledLinear(cfg.integrations);
  let linearR: { client: Resolved; webhook: Resolved } | undefined;
  if (linear) {
    linearR = {
      client: await resolveSecret("LINEAR_CLIENT_SECRET", secretDeps),
      webhook: await resolveSecret("LINEAR_WEBHOOK_SECRET", secretDeps),
    };
  }

  // Each typed value is offered for saving once its own check passed, so a
  // mistyped one is not saved and an accepted one is not lost to the other
  // check failing.
  let identity: Identity | undefined;
  let github: string;
  step(3, skipChecks ? "Checks before startup: skipped (--skip-checks)" : "Checks before startup");
  if (gh.app) {
    github = await appToken(gh.app, cfg, gh.key, secretDeps, { skipChecks, fetch });
    identity = appIdentity(gh.app.slug, gh.app.botUserId);
    // The webhook secret can't be checked here: GitHub only uses it to sign.
    await offerSave(gh.webhook, secretDeps);
  } else {
    let githubR = gh.token;
    if (!skipChecks) {
      ({ resolved: githubR, result: identity } = await checkWithRetry(githubR, secretDeps, (t) =>
        checkGithub(t, cfg.repos, fetch),
      ));
    }
    await offerSave(githubR, secretDeps);
    github = githubR.value;
  }
  if (skipChecks) {
    await offerSave(llmR, secretDeps);
    if (linearR) {
      await offerSave(linearR.client, secretDeps);
      await offerSave(linearR.webhook, secretDeps);
    }
  } else {
    ({ resolved: llmR } = await checkWithRetry(llmR, secretDeps, (key) =>
      checkLlm(cfg.llm, key, fetch),
    ));
    await offerSave(llmR, secretDeps);
    log(
      identity
        ? `GitHub: commits as ${identity.gitName} <${identity.gitEmail}>; LLM endpoint answered`
        : "GitHub: app token, no user identity (the harness image's default commit identity applies); LLM endpoint answered",
    );
    if (linear && linearR) {
      // Only the client secret can be checked here; the webhook secret is
      // offered with it once the app itself is accepted.
      let linearIdentity: LinearIdentity;
      ({ resolved: linearR.client, result: linearIdentity } = await checkWithRetry(
        linearR.client,
        secretDeps,
        (secret) => checkLinear(linear.clientId, secret, fetch, { log }),
      ));
      await offerSave(linearR.client, secretDeps);
      await offerSave(linearR.webhook, secretDeps);
      log(
        `Linear: devbox acts as ${linearIdentity.viewerName} in workspace ${linearIdentity.workspaceName}`,
      );
    }
  }
  const llm = llmR.value;
  if (!github) {
    log("warning: no GitHub token: cloning anonymously; GitHub calls from devbox will fail");
  }

  step(4, "Local keys");
  const opensandboxKey = await localKeys();

  step(5, "iron-proxy config");
  const composeEnv = composeEnvFor(env, cfg, {
    github,
    llm,
    opensandboxKey,
    linear: linearR && {
      clientSecret: linearR.client.value,
      webhookSecret: linearR.webhook.value,
    },
    githubApp: gh.app && { webhookSecret: gh.webhook.value, pem: gh.key?.pem },
  });
  writeFileSync(
    OUTPUT_PATH,
    renderIronProxyConfig(
      readFileSync(TEMPLATE_PATH, "utf8"),
      cfg,
      dnsResolver,
      ironProxyTokenOptions(app),
    ),
  );
  log(`wrote ${relative(ROOT, OUTPUT_PATH)}`);

  step(6, "Repos volume");
  await run(["bash", join(CP, "scripts", "build-repos-volume.sh"), CONFIG_PATH], {
    stdin: `${github}\n`,
  });

  step(7, "Images and startup");
  log(
    `Building the harness image. The first build takes ${FIRST_BUILD}; later ones reuse the cache.`,
  );
  await run([
    "make",
    "-C",
    join(ROOT, "harness"),
    "build",
    `IRON_PROXY_CA=${CA}`,
    ...(identity
      ? [`LOCAL_GIT_NAME=${identity.gitName}`, `LOCAL_GIT_EMAIL=${identity.gitEmail}`]
      : []),
  ]);
  for (const s of composeStartSteps(app)) {
    if (!s.ignore) {
      await run(s.cmd, { env: composeEnv });
      continue;
    }
    const res = await capture(s.cmd, { env: composeEnv });
    if (res.code !== 0 && !s.ignore.test(res.stderr)) {
      throw new UpError(
        `${s.cmd.slice(4).join(" ")} … exited with ${res.code}: ${res.stderr.trim()}`,
      );
    }
  }

  step(8, "Waiting for the control plane and logging the CLI in");
  await waitForHealth();
  const path = cliConfigPath(env, homedir());
  const outcome = await ensureCliLogin({
    path,
    profile: "local",
    url: API_URL,
    isValid: (c) => tokenIsValid(c.token),
    createToken: () => createToken(composeEnv),
  });
  log(
    outcome === "kept"
      ? `CLI profile "local" in ${path} is still valid`
      : `CLI logged in: profile "local" in ${path}`,
  );

  log(`
devbox is up at ${API_URL}. The agent works on the repos in devbox.config.json;
with more than one, name the repo in the task.

  bun run devbox create "Add a /health endpoint to ${cfg.repos[0]?.owner}/${cfg.repos[0]?.name}"
  bun run devbox logs -f <task>
  bun run devbox send <task> "Also add a test"
  bun run down`);
  if (linear) log("\nCheck Linear with: bun run linear:status");
  if (app) log("\nCheck GitHub with: bun run github:status");
}

if (import.meta.main) {
  try {
    await up(process.argv.slice(2));
  } catch (err) {
    const known = isKnownError(err, UpError);
    process.stderr.write(`\nbun run up: ${errorMessage(err)}\n`);
    if (!known && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  }
}
