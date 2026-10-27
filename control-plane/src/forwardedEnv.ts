// This is the reviewed contract between control-plane configuration and the
// harness. Do not replace it with prefix matching: platform-injected variables
// and stray control-plane settings must never become sandbox input.
export const FORWARDED_HARNESS_ENV_NAMES = [
  "HARNESS_LLM_PROVIDER",
  "HARNESS_LLM_BASE_URL",
  "HARNESS_LLM_API_KEY",
  "HARNESS_MODEL",
  "HARNESS_REASONING_EFFORT",
  "HARNESS_DISTILLATION_ENABLED",
  "HARNESS_REPO_KNOWLEDGE_DIR",
  "HARNESS_REVIEW_ENABLED",
  "HARNESS_REVIEW_MAX_ITERATIONS",
  "HARNESS_REVIEW_MAX_PARALLEL_LENSES",
  "HARNESS_SYNC_REPOS_BEFORE_PLANNING",
  "HARNESS_POLL_INTERVAL_SECONDS",
  "HARNESS_DEEPAGENTS_MODEL_TIMEOUT_SECONDS",
  "HARNESS_DEEPAGENTS_MODEL_MAX_RETRIES",
  "HARNESS_DEEPAGENTS_MAX_RETRIES",
  "HARNESS_DEEPAGENTS_RETRY_BASE_SECONDS",
  "HARNESS_DEEPAGENTS_RETRY_MAX_SECONDS",
  "HARNESS_DEEPAGENTS_RATE_LIMIT_MIN_SECONDS",
  "HARNESS_TRUSTED_BOT_IDS",
  "HARNESS_GIT_SIGNER_NAME",
  "HARNESS_GIT_SIGNER_EMAIL",
  "HARNESS_GPG_PRIVATE_KEY_FILE",
  "HARNESS_GPG_KEY_ID",
  "HARNESS_LANGFUSE_ENABLED",
  "HARNESS_SKIP_COMMIT",
  "HARNESS_DRY_RUN_PUBLISH",
  "HARNESS_EXP_CLASSIFIER_SKIP_ORIENTATION",
  "HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING",
] as const;

// These are harness settings too, but SandboxManager derives them from the
// control plane's GITHUB_TRUSTED_* configuration rather than forwarding them.
export const CONTROL_PLANE_DERIVED_HARNESS_ENV_NAMES = [
  "HARNESS_TRUSTED_ORGS",
  "HARNESS_TRUSTED_USERS",
] as const;

export const HARNESS_CONFIGURATION_ENV_NAMES = [
  ...FORWARDED_HARNESS_ENV_NAMES,
  ...CONTROL_PLANE_DERIVED_HARNESS_ENV_NAMES,
] as const;

export const MODEL_STAGES = [
  "ORIENTATION",
  "PLANNING",
  "PLAN_REVIEW",
  "IMPLEMENTATION",
  "DISTILLATION",
  "REVIEW",
  "FOLLOWUP",
] as const;

const forwardedNames = new Set<string>(FORWARDED_HARNESS_ENV_NAMES);
const modelStageNames = new Set<string>(MODEL_STAGES);

export function isForwardedHarnessEnvName(name: string): boolean {
  if (forwardedNames.has(name)) return true;
  const match = /^HARNESS_(.+)_(MODEL|REASONING_EFFORT)$/.exec(name);
  const stage = match?.[1];
  return stage !== undefined && modelStageNames.has(stage);
}

/** True for environment names Kubernetes may synthesize for a Service. */
export function isServiceLinkEnvName(name: string): boolean {
  return /_(?:SERVICE_HOST|SERVICE_PORT(?:_[A-Z0-9]+)*|PORT|PORT_[0-9]+_(?:TCP|UDP|SCTP)(?:_(?:ADDR|PORT|PROTO))?)$/.test(
    name,
  );
}

export function pickForwardedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isForwardedHarnessEnvName(name)) out[name] = value;
  }
  return out;
}
