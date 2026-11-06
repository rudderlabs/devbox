// `bun run gitlab:setup --target <file>`: resolve the public URL, check the
// GitLab token against the instance and the repos, learn the bot's identity
// from it, settle the trust lists, register one webhook per project with a
// token it generates, save that token (keychain, or shown once), record the
// settings in the target file and name the command that applies them. setup
// never applies and never touches the cluster; its network calls go only to
// the GitLab instance. Re-running is safe: each step reuses what is there.
import { randomBytes } from "node:crypto";
import { writeConfigKeys } from "../lib/configFile";
import { gitlabWebhookSecretName } from "../lib/integrations";
import { deploymentScope, entryName, keychainUsable } from "../lib/keychain";
import { publicUrlChangeLines, resolvePublicUrl } from "../lib/publicUrl";
import {
  checkWithRetry,
  offerSave,
  type ResolverDeps,
  resolveSecret,
  type SecretName,
} from "../lib/secrets";
import type { Fetch } from "../up/preflight";
import {
  checkGitlab,
  type GitlabIdentity,
  identityKnown,
  SIGNING_TOKEN_MIN_VERSION,
  versionAtLeast,
} from "./check";
import type { GitlabDeployment } from "./deployment";

export class SetupError extends Error {}

export type SetupOptions = {
  publicUrl?: string; // --public-url
  trustedGroups: string[]; // --trusted-group, repeatable
  trustedUsers: string[]; // --trusted-user, repeatable
  // --secret-token: the legacy X-Gitlab-Token instead of the signing token.
  secretToken: boolean;
  // --bot-username / --bot-user-id: the bot, when the token is in the user's
  // own Secret and cannot be asked.
  botUsername?: string;
  botUserId?: number;
  skipWebhook: boolean; // --skip-webhook
  skipPushCheck: boolean; // --skip-push-check
};

export type SetupDeps = {
  resolver: ResolverDeps;
  promptLine: (q: string) => Promise<string>;
  fetch: Fetch;
  log: (line: string) => void;
  // A file's text, or undefined when it does not exist.
  readFile: (path: string) => string | undefined;
  // The webhook token's random part; real randomness outside tests.
  random?: (bytes: number) => Buffer;
};

export const WEBHOOK_PATH = "/webhook/gitlab";
const HOOK_NAME = "devbox";

const enc = (owner: string, name: string) => encodeURIComponent(`${owner}/${name}`);

// The trust lists this run settles: the flags, else the saved ones, else the
// namespace of the first repo (a group, or group/subgroup).
function trustLists(d: GitlabDeployment, opts: SetupOptions, log: (l: string) => void) {
  if (opts.trustedGroups.length > 0 || opts.trustedUsers.length > 0) {
    return { trustedGroups: opts.trustedGroups, trustedUsers: opts.trustedUsers };
  }
  if (d.trust.trustedGroups.length > 0 || d.trust.trustedUsers.length > 0) return d.trust;
  const first = d.repos[0];
  const group = first ? first.owner : "";
  log(
    `Trust: no --trusted-group or --trusted-user and none saved: trusting the members of group ${group} (the namespace of ${first?.url})`,
  );
  return { trustedGroups: [group], trustedUsers: [] };
}

// A new webhook token: `whsec_` + 32 random bytes in base64 for the signing
// token, 32 random bytes in hex for the legacy secret.
export function newWebhookToken(
  auth: "signing" | "secret",
  random: (bytes: number) => Buffer = (n) => randomBytes(n),
): string {
  const bytes = random(32);
  return auth === "signing" ? `whsec_${bytes.toString("base64")}` : bytes.toString("hex");
}

type Hook = { id: number; url: string };

// The project's devbox webhook, created or updated to this URL and token.
// Returns false when the token may not manage hooks (Maintainer needed).
async function registerHook(
  d: GitlabDeployment,
  token: string,
  repo: { owner: string; name: string },
  hookUrl: string,
  auth: "signing" | "secret",
  webhookToken: string,
  deps: SetupDeps,
): Promise<boolean> {
  const base = d.instance?.baseUrl ?? "";
  const ca = d.instance?.caFile ? deps.readFile(d.instance.caFile) : undefined;
  const api = async (method: string, path: string, body?: unknown) =>
    deps.fetch(`${base}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(ca ? { tls: { ca } } : {}),
    } as RequestInit);
  const project = `/projects/${enc(repo.owner, repo.name)}`;
  const list = await api("GET", `${project}/hooks`);
  if (list.status === 403) {
    await list.body?.cancel();
    return false;
  }
  if (!list.ok) {
    throw new SetupError(
      `GET ${project}/hooks returned ${list.status}: ${(await list.text()).slice(0, 200)}`,
    );
  }
  const hooks = ((await list.json()) as Hook[]).filter((h) => h.url === hookUrl);
  const body = {
    url: hookUrl,
    name: HOOK_NAME,
    description: "devbox: merge request notes and pipelines",
    note_events: true,
    pipeline_events: true,
    push_events: false,
    merge_requests_events: false,
    confidential_note_events: false,
    enable_ssl_verification: true,
    ...(auth === "signing" ? { signing_token: webhookToken } : { token: webhookToken }),
  };
  const res =
    hooks.length > 0
      ? await api("PUT", `${project}/hooks/${hooks[0]?.id}`, body)
      : await api("POST", `${project}/hooks`, body);
  if (res.status === 403) {
    await res.body?.cancel();
    return false;
  }
  if (!res.ok) {
    const text = (await res.text()).replaceAll(webhookToken, "***").slice(0, 200);
    throw new SetupError(
      `${hooks.length > 0 ? "PUT" : "POST"} ${project}/hooks returned ${res.status}: ${text}`,
    );
  }
  await res.body?.cancel();
  return true;
}

export async function setup(
  d: GitlabDeployment,
  opts: SetupOptions,
  deps: SetupDeps,
): Promise<void> {
  const { log, resolver } = deps;
  if (!d.instance) {
    throw new SetupError(
      "no GitLab instance configured: set gitlab.baseUrl in devbox.config.json and add a repo under it to repos first (docs/gitlab.md)",
    );
  }
  if (d.repos.length === 0) {
    throw new SetupError(
      `no repo under ${d.instance.baseUrl} in devbox.config.json's repos: add one first (docs/gitlab.md)`,
    );
  }
  let ca: string | undefined;
  if (d.instance.caFile) {
    ca = deps.readFile(d.instance.caFile);
    if (!ca) throw new SetupError(`gitlab.caFile ${d.instance.caFile}: cannot read it`);
  }

  // 1. The public URL.
  const publicUrl = await resolvePublicUrl(d, opts, deps);
  log(`Public URL: ${publicUrl}`);
  const hookUrl = `${publicUrl}${WEBHOOK_PATH}`;

  // 2. Trust, before the token check that verifies it.
  const trust = trustLists(d, opts, log);

  // 3. The token, checked against the instance, the repos and the trust
  // lists; it tells who the bot is.
  let token: string | undefined;
  let identity: GitlabIdentity | undefined;
  if (d.byoGitlabSecret) {
    log(
      `GitLab token: in your Secret "${d.byoGitlabSecret}" (not read): skipping the token checks`,
    );
  } else {
    // Stands in for /api/v4/user when the token may not read it.
    const knownUsername = opts.botUsername ?? d.gitlab?.botUsername;
    const knownId = opts.botUserId ?? d.gitlab?.botUserId;
    const knownBot =
      knownUsername !== undefined && knownId !== undefined
        ? { username: knownUsername, id: knownId }
        : undefined;
    let r = await resolveSecret("GITLAB_TOKEN", resolver);
    ({ resolved: r, result: identity } = await checkWithRetry(r, resolver, (value) =>
      checkGitlab(d.instance as { baseUrl: string }, value, d.repos, deps.fetch, {
        requirePush: !opts.skipPushCheck,
        webhooks: { trustedGroups: trust.trustedGroups },
        ...(ca !== undefined ? { ca } : {}),
        ...(knownBot ? { identity: knownBot } : {}),
      }),
    ));
    await offerSave(r, resolver);
    token = r.value;
    log(
      identityKnown(identity)
        ? `GitLab ${identity.version || "(version unknown)"} at ${d.instance.baseUrl}: devbox acts as ${identity.username} (id ${identity.id}${identity.bot ? ", a bot user" : ""})`
        : `GitLab ${identity.version || "(version unknown)"} at ${d.instance.baseUrl}: the token may not read /api/v4/user (no User: Read), so the bot must be named with --bot-username and --bot-user-id`,
    );
    if (identityKnown(identity) && !identity.bot) {
      log(
        `Note: ${identity.username} is a person, not a bot user, so their own comments are ignored as the bot's: prefer a group or project access token (docs/gitlab.md#what-you-need)`,
      );
    }
  }

  // 4. The bot: from the token, else the flags, else what is saved.
  const known = identity && identityKnown(identity) ? identity : undefined;
  const botUsername = known?.username ?? opts.botUsername ?? d.gitlab?.botUsername;
  const botUserId = known?.id ?? opts.botUserId ?? d.gitlab?.botUserId;
  if (botUsername === undefined || botUserId === undefined) {
    throw new SetupError(
      "the bot's identity is unknown: pass --bot-username and --bot-user-id (GET <baseUrl>/api/v4/user with the token prints them)",
    );
  }

  // 5. The webhook token: signing (19.1+) unless --secret-token or an older
  // instance; reused from the keychain when saved, generated otherwise.
  // An unknown version (the token may not read it) is taken as current.
  const signingOk = identity?.version
    ? versionAtLeast(identity.version, SIGNING_TOKEN_MIN_VERSION)
    : true;
  const auth: "signing" | "secret" = opts.secretToken || !signingOk ? "secret" : "signing";
  if (!opts.secretToken && !signingOk) {
    log(
      `GitLab ${identity?.version} is below ${SIGNING_TOKEN_MIN_VERSION}: using the legacy secret token (X-Gitlab-Token) for the webhook`,
    );
  }
  const secretName: SecretName = gitlabWebhookSecretName({ webhookAuth: auth });
  const k = resolver.keychain;
  const usable = await keychainUsable(k, entryName(d.deployment, secretName));
  const saved = usable ? await k?.get(entryName(d.deployment, secretName)) : undefined;
  const fromEnv = resolver.env[secretName] || undefined;
  const webhookToken = fromEnv ?? saved ?? newWebhookToken(auth, deps.random);
  const source = fromEnv ? "env" : saved ? "keychain" : "new";

  // 6. The webhooks, one per project.
  let registered = true;
  if (opts.skipWebhook) {
    log("Webhooks: not registered (--skip-webhook)");
  } else if (token === undefined) {
    registered = false;
  } else {
    for (const repo of d.repos) {
      const ok = await registerHook(d, token, repo, hookUrl, auth, webhookToken, deps);
      if (!ok) {
        registered = false;
        break;
      }
      log(`Webhook on ${repo.owner}/${repo.name}: ${hookUrl} (note and pipeline events)`);
    }
  }
  if (!registered) {
    log(
      `The token may not manage webhooks (Maintainer role needed). Create one on each project by hand:`,
    );
    log(
      `  URL ${hookUrl}, triggers Comments and Pipeline events, ${auth === "signing" ? "signing" : "secret"} token as below`,
    );
  }

  // 7. Save the webhook token where the apply command will find it.
  const scope = deploymentScope(d.deployment);
  if (source === "new") {
    let kept = false;
    if (d.byoIntegrationsSecret) {
      log(
        `Put ${secretName} in Secret "${d.byoIntegrationsSecret}" in namespace ${d.deployment.kind === "k8s" ? d.deployment.namespace : "devbox"}:`,
      );
    } else if (resolver.isTTY && k && usable) {
      kept = await resolver.confirm(
        `Save the webhook token (${secretName}) to the system keychain for ${scope}? [Y/n] `,
        { defaultYes: true },
      );
      if (kept) await k.set(entryName(d.deployment, secretName), webhookToken);
      kept = kept && !k.disabled;
    }
    if (!kept) {
      log(`The webhook token, shown once (set it as ${secretName} before ${d.applyCommand}):`);
      log(`  ${webhookToken}`);
    }
  } else {
    log(
      `Webhook token: ${secretName} from ${source === "env" ? "your environment" : `the system keychain (${scope})`}`,
    );
  }

  // 8. Write.
  const ciResults = d.gitlab?.ciResults ?? true;
  writeConfigKeys(d.configPath, {
    "integrations.gitlab": { enabled: true, botUsername, botUserId, ciResults, webhookAuth: auth },
    [`${d.trustKey}.trustedGroups`]: trust.trustedGroups,
    [`${d.trustKey}.trustedUsers`]: trust.trustedUsers,
    publicUrl,
  });
  log(`Wrote integrations.gitlab and ${d.trustKey} to ${d.configPath}`);
  for (const line of publicUrlChangeLines(
    d.publicUrl,
    publicUrl,
    { linear: d.linear, ...(d.githubApp ? { githubApp: d.githubApp } : {}) },
    "linear",
    d.deployment.kind === "k8s" ? ` --target ${d.configPath}` : "",
  )) {
    log(line);
  }

  // 9. Next step.
  log(`Next: ${d.applyCommand}`);
  log(
    `With GitOps, set these chart values instead: integrations.gitlab {enabled: true, botUsername: ${botUsername}, botUserId: ${botUserId}}, gitlab.trustedGroups, and ${secretName} in the integrations Secret`,
  );
  log(`Then check GitLab with: ${d.statusCommand}`);
}
