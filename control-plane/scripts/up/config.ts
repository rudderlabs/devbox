// Loads and validates devbox.config.json: the setup, `repos`
// and `llm`, plus the Compose deployment's `integrations` and sandbox sizing.
// The k8s commands skip those blocks ({ integrations: false }) and read the
// target file's values instead. Where it runs is a target file (k8s/target.ts) or
// `bun run up`'s flags. A broken file stops `bun run up` before it touches
// Docker, with an error naming the field.
import { readFileSync } from "node:fs";
import { enabledGithubApp, type Integrations, parseIntegrations } from "../lib/integrations";
import { parsePublicUrl } from "../lib/publicUrl";

export type Provider = "openai" | "anthropic";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const LLM_STAGES = {
  orientation: "ORIENTATION",
  planning: "PLANNING",
  planReview: "PLAN_REVIEW",
  implementation: "IMPLEMENTATION",
  distillation: "DISTILLATION",
  review: "REVIEW",
  followup: "FOLLOWUP",
} as const;

export type LlmStage = keyof typeof LLM_STAGES;
export type LlmStageConfig = { model?: string; reasoningEffort?: ReasoningEffort };
export type LlmConfig = {
  provider: Provider;
  baseUrl: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  stages?: Partial<Record<LlmStage, LlmStageConfig>>;
};

export type CodeHost = "github" | "gitlab";
export type RepoConfig = {
  url: string;
  branch: string;
  // github for https://github.com/<owner>/<name>.git; gitlab for a repo under
  // gitlab.baseUrl, <base>/<owner>/<name>.git, where owner is the namespace
  // path (a group, or group/subgroup).
  host: CodeHost;
  owner: string;
  name: string;
};

// The configured GitLab instance, or undefined: {baseUrl} with no trailing
// slash; caFile, the PEM of the private CA that signed its certificate, when
// it has one (the installer puts it in a Secret for the chart; `up` mounts
// it); and who may drive the agent from GitLab (Compose; on k8s these are the
// target's values.gitlab). Empty lists by default.
export type GitlabConfig = {
  baseUrl: string;
  caFile?: string;
  // Always set by the parser; optional so callers that only know the instance
  // (the k8s commands, which take trust from the target) can build one.
  trustedGroups?: string[];
  trustedUsers?: string[];
};

// The repos on GitHub: what the GitHub token checks and the App's token cover.
export const githubRepos = (repos: readonly RepoConfig[]): RepoConfig[] =>
  repos.filter((r) => r.host === "github");
export const gitlabRepos = (repos: readonly RepoConfig[]): RepoConfig[] =>
  repos.filter((r) => r.host === "gitlab");
// Whether the deployment talks to GitHub at all: a repo there, or the GitHub
// App. Without either no GitHub token is asked for, checked or needed (the
// token Secret then exists empty on Kubernetes, a placeholder on Compose).
export const needsGithub = (repos: readonly RepoConfig[], githubApp: unknown): boolean =>
  githubApp !== undefined || githubRepos(repos).length > 0;

export type SandboxConfig = { maxConcurrent: number; cpu: string; memory: string };

type BaseDevboxConfig = {
  repos: RepoConfig[];
  llm: LlmConfig;
  // Set when any repo may live on a GitLab instance.
  gitlab?: GitlabConfig;
  // The deployment's public URL for webhooks, validated.
  publicUrl?: string;
  // Who may drive the agent from GitHub (Compose; on k8s these are chart
  // values). Empty lists by default.
  github: { trustedOrgs: string[]; trustedUsers: string[] };
  // Per-deployment integrations; {} when absent.
  integrations: Integrations;
};

export type ComposeDevboxConfig = BaseDevboxConfig & { sandbox: SandboxConfig };
export type K8sDevboxConfig = BaseDevboxConfig & { sandbox?: never };
export type DevboxConfig = ComposeDevboxConfig | K8sDevboxConfig;

export class ConfigError extends Error {}

// integrations: false leaves all Compose-only blocks unread, so one cannot
// stop or influence a k8s command.
export type ConfigOptions = { integrations?: boolean };

const FILE = "devbox.config.json";
const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([^/]+)\.git$/;
// Under gitlab.baseUrl: <group>[/<subgroup>...]/<project>.git.
const GITLAB_REPO_PATH = /^([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/([^/]+)\.git$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
// The LLM host becomes a Docker network alias: a DNS name, no IP literals.
const HOSTNAME = /^(?=.*[A-Za-z])[A-Za-z0-9.-]+$/;
const CPU_QUANTITY = /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*|[1-9]\d*m)$/;
const MEMORY_QUANTITY = /^(?:[1-9]\d*)(?:Ki|Mi|Gi|Ti)$/;
const SANDBOX_DEFAULTS: SandboxConfig = { maxConcurrent: 5, cpu: "2", memory: "4Gi" };

// Keep in sync with _SUPPORTED_REASONING_EFFORTS in
// harness/src/harness/deepagents/model.py and the list in
// deploy/helm/devbox/templates/validate.yaml.
const SUPPORTED_REASONING_EFFORTS: Record<Provider, readonly ReasoningEffort[]> = {
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
};

const LLM_KEYS: readonly string[] = ["provider", "baseUrl", "model", "reasoningEffort", "stages"];

const fail = (message: string): never => {
  throw new ConfigError(`${FILE}: ${message}`);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The GitLab part of a repo URL, "<owner>/<name>.git" under the instance, or
// undefined when the URL is not under it.
function gitlabRepoPath(url: string, gitlab: GitlabConfig | undefined): string | undefined {
  if (!gitlab) return undefined;
  const prefix = `${gitlab.baseUrl}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
}

function parseRepo(raw: unknown, i: number, gitlab: GitlabConfig | undefined): RepoConfig {
  const field = `repos[${i}]`;
  if (!isObject(raw)) return fail(`${field}: must be an object with a url`);
  const url = raw.url;
  let host: CodeHost = "github";
  let m = typeof url === "string" ? REPO_URL.exec(url) : null;
  const underGitlab = typeof url === "string" ? gitlabRepoPath(url, gitlab) : undefined;
  if (!m && underGitlab !== undefined) {
    host = "gitlab";
    m = GITLAB_REPO_PATH.exec(underGitlab);
    if (!m) {
      return fail(
        `${field}.url: a GitLab repo is ${gitlab?.baseUrl}/<group>[/<subgroup>]/<project>.git, got ${url}`,
      );
    }
  }
  if (!m?.[1] || !m[2]) {
    const alt = gitlab ? ` or ${gitlab.baseUrl}/<group>/<project>.git` : "";
    return fail(
      `${field}.url: must be https://github.com/<owner>/<repo>.git${alt}, got ${String(url)}`,
    );
  }
  const [, owner, name] = m;
  if (!REPO_NAME.test(name) || name === "." || name === ".." || name.startsWith("-")) {
    return fail(`${field}.url: bad repo name "${name}"`);
  }
  const branch = raw.branch ?? "main";
  if (
    typeof branch !== "string" ||
    !BRANCH.test(branch) ||
    branch.startsWith("-") ||
    branch.includes("..")
  ) {
    return fail(`${field}.branch: bad branch "${String(branch)}"`);
  }
  return { url: url as string, branch, host, owner, name };
}

// gitlab: {baseUrl, caFile, trustedGroups, trustedUsers}. The URL's origin
// and path, no trailing slash; like llm.baseUrl it must use the default port,
// because iron-proxy intercepts only 443. The chart validates the same way
// (templates/validate.yaml). caFile is read by `up` and the installer, not
// here. The trust lists are Compose's; a k8s target holds its own.
function parseGitlab(raw: unknown): GitlabConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return fail("gitlab: must be an object");
  const allowed = ["baseUrl", "caFile", "trustedGroups", "trustedUsers"];
  const extra = Object.keys(raw).find((k) => !allowed.includes(k));
  if (extra !== undefined) {
    return fail(`gitlab: unknown key ${JSON.stringify(extra)} (allowed: ${allowed.join(", ")})`);
  }
  let caFile: string | undefined;
  if (raw.caFile !== undefined) {
    if (typeof raw.caFile !== "string" || !raw.caFile.startsWith("/")) {
      return fail("gitlab.caFile: must be an absolute path to a PEM file");
    }
    caFile = raw.caFile;
  }
  const baseUrl = raw.baseUrl;
  const url = typeof baseUrl === "string" && URL.canParse(baseUrl) ? new URL(baseUrl) : null;
  if (!url || url.protocol !== "https:") {
    return fail(`gitlab.baseUrl: must be an https URL, got ${String(baseUrl)}`);
  }
  if (!HOSTNAME.test(url.hostname)) {
    return fail(`gitlab.baseUrl: the host must be a DNS name, got ${url.hostname}`);
  }
  if (url.port) {
    return fail(`gitlab.baseUrl: must use the default port (443), got ${url.port}`);
  }
  if (url.search || url.hash || url.username || url.password) {
    return fail("gitlab.baseUrl: must not have a query, fragment or credentials");
  }
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    ...(caFile !== undefined ? { caFile } : {}),
    trustedGroups: parseTrustList(raw, "trustedGroups", "gitlab").map((group, i) =>
      GITLAB_GROUP_PATH.test(group)
        ? group
        : fail(`gitlab.trustedGroups[${i}]: not a group path, got ${group}`),
    ),
    trustedUsers: parseTrustList(raw, "trustedUsers", "gitlab").map((user, i) =>
      GITLAB_USERNAME.test(user)
        ? user
        : fail(`gitlab.trustedUsers[${i}]: not a username, got ${user}`),
    ),
  };
}

// A group's full path and a username, as the chart's validate.yaml takes
// them. Each trusted group becomes a path in the proxy's allowlist
// (/api/v4/groups/<group>/members/all), where a `*` would be a wildcard.
const GITLAB_GROUP_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const GITLAB_USERNAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function parseReasoningEffort(raw: unknown, provider: Provider, field: string): ReasoningEffort {
  const supported = SUPPORTED_REASONING_EFFORTS[provider];
  if (typeof raw !== "string" || !supported.includes(raw as ReasoningEffort)) {
    return fail(
      `${field}: must be one of ${supported.join(", ")} for provider ${provider}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw as ReasoningEffort;
}

function parseStageConfig(raw: unknown, stage: LlmStage, provider: Provider): LlmStageConfig {
  const field = `llm.stages.${stage}`;
  if (!isObject(raw)) return fail(`${field}: must be an object`);
  const extra = Object.keys(raw).find((key) => key !== "model" && key !== "reasoningEffort");
  if (extra !== undefined) {
    return fail(`${field}.${extra}: unknown field (allowed: model, reasoningEffort)`);
  }
  const out: LlmStageConfig = {};
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !raw.model.trim()) {
      return fail(`${field}.model: must be a non-empty string`);
    }
    out.model = raw.model.trim();
  }
  if (raw.reasoningEffort !== undefined) {
    out.reasoningEffort = parseReasoningEffort(
      raw.reasoningEffort,
      provider,
      `${field}.reasoningEffort`,
    );
  }
  return out;
}

function parseStages(raw: unknown, provider: Provider): LlmConfig["stages"] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return fail("llm.stages: must be an object");
  const stages: NonNullable<LlmConfig["stages"]> = {};
  for (const [stage, value] of Object.entries(raw)) {
    if (!Object.hasOwn(LLM_STAGES, stage)) return fail(`llm.stages.${stage}: unknown stage`);
    const key = stage as LlmStage;
    stages[key] = parseStageConfig(value, key, provider);
  }
  return stages;
}

function parseLlm(raw: unknown): DevboxConfig["llm"] {
  if (!isObject(raw)) return fail("llm: required");
  const baseUrl = raw.baseUrl;
  const url = typeof baseUrl === "string" && URL.canParse(baseUrl) ? new URL(baseUrl) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return fail(`llm.baseUrl: must be an http(s) URL, got ${String(baseUrl)}`);
  }
  if (!HOSTNAME.test(url.hostname)) {
    return fail(`llm.baseUrl: the host must be a DNS name, got ${url.hostname}`);
  }
  // iron-proxy only intercepts ports 80 and 443 (URL drops a default port).
  if (url.port) {
    return fail(`llm.baseUrl: must use the default port (80 or 443), got ${url.port}`);
  }
  if (url.search || url.hash || url.username || url.password) {
    return fail("llm.baseUrl: must not have a query, fragment or credentials");
  }
  const provider = raw.provider ?? "openai";
  if (provider !== "openai" && provider !== "anthropic") {
    return fail(`llm.provider: must be "openai" or "anthropic", got ${JSON.stringify(provider)}`);
  }
  const model = raw.model;
  if (typeof model !== "string" || !model.trim()) return fail("llm.model: required");
  // Each provider has one API: OpenAI's Responses API, Anthropic's Messages API.
  if (raw.wireApi !== undefined) {
    return fail(
      'llm.wireApi: no longer supported; provider "openai" always uses the Responses API',
    );
  }
  // A misspelled optional key would otherwise be dropped without a word.
  const extra = Object.keys(raw).find((key) => !LLM_KEYS.includes(key));
  if (extra !== undefined) {
    return fail(`llm.${extra}: unknown field (allowed: ${LLM_KEYS.join(", ")})`);
  }
  const normalized = (baseUrl as string).replace(/\/+$/, "");
  // The SDK appends /v1/messages, so a /v1 segment would be doubled.
  if (provider === "anthropic" && /\/v1(\/|$)/.test(url.pathname)) {
    return fail(
      'llm.baseUrl: for provider "anthropic" use the API root without /v1, for example https://api.anthropic.com',
    );
  }
  return {
    provider,
    baseUrl: normalized,
    model: model.trim(),
    ...(raw.reasoningEffort !== undefined
      ? {
          reasoningEffort: parseReasoningEffort(
            raw.reasoningEffort,
            provider,
            "llm.reasoningEffort",
          ),
        }
      : {}),
    ...(raw.stages !== undefined ? { stages: parseStages(raw.stages, provider) } : {}),
  };
}

function parseTrustList(raw: Record<string, unknown>, key: string, block = "github"): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  const field = `${block}.${key}`;
  if (!Array.isArray(v)) return fail(`${field}: must be a list of non-empty strings`);
  return v.map((item, i) =>
    typeof item === "string" && item.trim()
      ? item.trim()
      : fail(`${field}[${i}]: must be a non-empty string`),
  );
}

function parseGithub(raw: unknown): DevboxConfig["github"] {
  if (raw === undefined) return { trustedOrgs: [], trustedUsers: [] };
  if (!isObject(raw)) return fail("github: must be an object");
  const extra = Object.keys(raw).find((k) => k !== "trustedOrgs" && k !== "trustedUsers");
  if (extra !== undefined) {
    return fail(
      `github: unknown key ${JSON.stringify(extra)} (allowed: trustedOrgs, trustedUsers)`,
    );
  }
  return {
    trustedOrgs: parseTrustList(raw, "trustedOrgs"),
    trustedUsers: parseTrustList(raw, "trustedUsers"),
  };
}

function parseSandbox(raw: unknown): SandboxConfig {
  if (raw === undefined) return { ...SANDBOX_DEFAULTS };
  if (!isObject(raw)) return fail("sandbox: must be an object");
  const allowed = ["maxConcurrent", "cpu", "memory"];
  const extra = Object.keys(raw).find((key) => !allowed.includes(key));
  if (extra !== undefined) {
    return fail(
      `sandbox: unknown key ${JSON.stringify(extra)} (allowed: maxConcurrent, cpu, memory)`,
    );
  }

  const maxConcurrent =
    raw.maxConcurrent === undefined ? SANDBOX_DEFAULTS.maxConcurrent : raw.maxConcurrent;
  if (typeof maxConcurrent !== "number" || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    return fail("sandbox.maxConcurrent: must be an integer greater than or equal to 1");
  }
  const cpu = raw.cpu === undefined ? SANDBOX_DEFAULTS.cpu : raw.cpu;
  if (typeof cpu !== "string" || !CPU_QUANTITY.test(cpu)) {
    return fail('sandbox.cpu: must be a positive CPU quantity such as "2", "1.5" or "500m"');
  }
  const memory = raw.memory === undefined ? SANDBOX_DEFAULTS.memory : raw.memory;
  if (typeof memory !== "string" || !MEMORY_QUANTITY.test(memory)) {
    return fail(
      'sandbox.memory: must be a positive binary memory quantity such as "512Mi" or "4Gi"',
    );
  }
  return { maxConcurrent, cpu, memory };
}

export function parseConfig(raw: unknown): ComposeDevboxConfig;
export function parseConfig(raw: unknown, opts: { integrations?: true }): ComposeDevboxConfig;
export function parseConfig(raw: unknown, opts: { integrations: false }): K8sDevboxConfig;
export function parseConfig(raw: unknown, opts: ConfigOptions = {}): DevboxConfig {
  if (!isObject(raw)) return fail("must be a JSON object");
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    return fail("repos: must be a non-empty list");
  }
  const gitlab = parseGitlab(raw.gitlab);
  const repos = raw.repos.map((r: unknown, i: number) => parseRepo(r, i, gitlab));
  // Every repo is cloned to /workspace/<name>, so names must be unique.
  repos.forEach((r, i) => {
    if (repos.findIndex((o) => o.name === r.name) !== i) {
      fail(
        `repos[${i}].url: another repo is also named "${r.name}" (each repo is cloned to /workspace/<repo>)`,
      );
    }
  });
  const withIntegrations = opts.integrations !== false;
  // The k8s commands skip the Compose-only blocks: their trust lists and sandbox
  // resources are chart values.
  const github = withIntegrations ? parseGithub(raw.github) : parseGithub(undefined);
  const integrations = withIntegrations
    ? parseIntegrations(raw.integrations, fail, { platform: "compose" })
    : {};
  if (
    enabledGithubApp(integrations) &&
    github.trustedOrgs.length === 0 &&
    github.trustedUsers.length === 0
  ) {
    return fail(
      "integrations.githubApp: needs github.trustedOrgs or github.trustedUsers (who may drive the agent from GitHub)",
    );
  }
  const base: BaseDevboxConfig = {
    repos,
    llm: parseLlm(raw.llm),
    ...(gitlab ? { gitlab } : {}),
    github,
    integrations,
  };
  if (!withIntegrations) return base;
  return {
    ...base,
    sandbox: parseSandbox(raw.sandbox),
    // Compose only: the k8s commands take the public URL from the chart values.
    ...(raw.publicUrl !== undefined
      ? { publicUrl: parsePublicUrl(raw.publicUrl, "publicUrl", fail) }
      : {}),
  };
}

export function loadConfig(path: string): ComposeDevboxConfig;
export function loadConfig(path: string, opts: { integrations?: true }): ComposeDevboxConfig;
export function loadConfig(path: string, opts: { integrations: false }): K8sDevboxConfig;
export function loadConfig(path: string, opts: ConfigOptions = {}): DevboxConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`${FILE} not found — copy devbox.config.example.json`);
    }
    throw new ConfigError(`${FILE}: cannot read it (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${FILE}: not valid JSON`);
  }
  return opts.integrations === false ? parseConfig(raw, { integrations: false }) : parseConfig(raw);
}
