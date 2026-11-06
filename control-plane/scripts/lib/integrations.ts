// The `integrations` block of a deployment's config: each
// integration's `enabled` switch and its non-secret settings. Linear, Jira
// and the GitHub App on both platforms; Slack on Kubernetes only. Secrets
// never live here, and a secret never turns an integration on: only
// `enabled: true` does. Unknown keys are refused so a typo (or a pasted
// secret) fails loudly.

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parsePublicUrl } from "./publicUrl";

export type LinearIntegration = { enabled: boolean; clientId?: string };
export type SlackIntegration = { enabled: boolean; channelId?: string };
// The GitHub App and its webhooks, one switch. tokenScope and ciResults
// are always filled with their defaults; the other keys are required only when
// enabled is true.
export type GithubAppIntegration = {
  enabled: boolean;
  appId?: number;
  slug?: string;
  installationId?: number;
  botUserId?: number;
  tokens?: "devbox" | "external";
  tokenScope: "repos" | "installation";
  ciResults: boolean;
  // Compose, tokens "external": the file the user's own process keeps fresh.
  tokenFile?: string;
  // The owning organization's login; absent for an App owned by a user.
  org?: string;
  // A new App registered to replace this one, waiting for its install;
  // only github:setup reads it.
  pending?: PendingGithubApp;
};
// publicUrl: the public URL the new App was set up with, when it differs
// from the saved one; it becomes the deployment's once the App is installed.
export type PendingGithubApp = { appId: number; slug: string; org?: string; publicUrl?: string };
// Jira Cloud through a service account. botAccountId and botName are what
// GET /myself answered at setup; statuses are the names devbox moves an issue
// to (an absent one means no move); trustedGroups and trustedUsers (account
// ids) narrow who may drive devbox, which without them is every person on
// the site.
export type JiraIntegration = {
  enabled: boolean;
  siteUrl?: string;
  cloudId?: string;
  botEmail?: string;
  botAccountId?: string;
  botName?: string;
  projectKeys?: string[];
  trustedGroups?: string[];
  trustedUsers?: string[];
  statuses?: JiraStatuses;
  // The API token's expiry, YYYY-MM-DD.
  tokenExpiresAt?: string;
  allowRestrictedIssues?: boolean;
};
export type JiraStatuses = { started?: string; done?: string; failed?: string };
export type Integrations = {
  linear?: LinearIntegration;
  slack?: SlackIntegration;
  githubApp?: GithubAppIntegration;
  jira?: JiraIntegration;
};

export type EnabledLinear = LinearIntegration & { enabled: true; clientId: string };

// The Linear block when Linear is on; parseIntegrations guarantees its clientId.
export function enabledLinear(i: Integrations): EnabledLinear | undefined {
  const l = i.linear;
  return l?.enabled && l.clientId ? (l as EnabledLinear) : undefined;
}

export type EnabledGithubApp = GithubAppIntegration & {
  enabled: true;
  appId: number;
  slug: string;
  installationId: number;
  botUserId: number;
  tokens: "devbox" | "external";
};

// The GitHub App block when it is on; parseIntegrations guarantees its keys.
export function enabledGithubApp(i: Integrations): EnabledGithubApp | undefined {
  const g = i.githubApp;
  return g?.enabled ? (g as EnabledGithubApp) : undefined;
}

export type EnabledJira = JiraIntegration & {
  enabled: true;
  siteUrl: string;
  cloudId: string;
  botEmail: string;
  botAccountId: string;
  botName: string;
  projectKeys: string[];
  tokenExpiresAt: string;
};

// The Jira block when Jira is on; parseIntegrations guarantees its keys.
export function enabledJira(i: Integrations): EnabledJira | undefined {
  const j = i.jira;
  return j?.enabled ? (j as EnabledJira) : undefined;
}

type Fail = (msg: string) => never;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  fail: Fail,
): void {
  const extra = Object.keys(obj).find((k) => !allowed.includes(k));
  if (extra !== undefined) {
    fail(`${field}: unknown key ${JSON.stringify(extra)} (allowed: ${allowed.join(", ")})`);
  }
}

// The block as an object with only `keys` and `enabled`, a boolean.
function block(
  raw: unknown,
  name: string,
  keys: readonly string[],
  fail: Fail,
): { obj: Record<string, unknown>; enabled: boolean } {
  const field = `integrations.${name}`;
  if (!isObject(raw)) return fail(`${field}: must be an object`);
  onlyKeys(raw, ["enabled", ...keys], field, fail);
  if (typeof raw.enabled !== "boolean") return fail(`${field}.enabled: required, true or false`);
  return { obj: raw, enabled: raw.enabled };
}

// A setting: validated when present (even with the integration off), and
// required when it is on.
function setting<T>(
  b: { obj: Record<string, unknown>; enabled: boolean },
  field: string,
  key: string,
  parse: (v: unknown, field: string) => T,
  fail: Fail,
): T | undefined {
  const f = `${field}.${key}`;
  if (b.obj[key] === undefined) {
    return b.enabled ? fail(`${f}: required when enabled is true`) : undefined;
  }
  return parse(b.obj[key], f);
}

const nonEmpty =
  (fail: Fail) =>
  (v: unknown, field: string): string =>
    typeof v === "string" && v.trim() ? v.trim() : fail(`${field}: must be a non-empty string`);

const positiveInt =
  (fail: Fail) =>
  (v: unknown, field: string): number =>
    typeof v === "number" && Number.isInteger(v) && v > 0
      ? v
      : fail(`${field}: must be a positive integer`);

function parseLinear(raw: unknown, fail: Fail): LinearIntegration {
  const f = "integrations.linear";
  // The public URL is the deployment's, not Linear's.
  if (isObject(raw) && "publicUrl" in raw) {
    return fail(
      `${f}: unknown key "publicUrl" (allowed: enabled, clientId); moved to the top-level publicUrl`,
    );
  }
  const b = block(raw, "linear", ["clientId"], fail);
  const out: LinearIntegration = { enabled: b.enabled };
  const clientId = setting(b, f, "clientId", nonEmpty(fail), fail);
  if (clientId !== undefined) out.clientId = clientId;
  return out;
}

function parseSlack(raw: unknown, fail: Fail): SlackIntegration {
  const b = block(raw, "slack", ["channelId"], fail);
  const channelId = setting(b, "integrations.slack", "channelId", nonEmpty(fail), fail);
  return { enabled: b.enabled, ...(channelId !== undefined ? { channelId } : {}) };
}

function parseGithubApp(
  raw: unknown,
  fail: Fail,
  platform: "compose" | "k8s",
): GithubAppIntegration {
  const f = "integrations.githubApp";
  const b = block(
    raw,
    "githubApp",
    [
      "appId",
      "slug",
      "installationId",
      "botUserId",
      "tokens",
      "tokenScope",
      "ciResults",
      "tokenFile",
      "org",
      "pending",
    ],
    fail,
  );
  const appId = setting(b, f, "appId", positiveInt(fail), fail);
  const slug = setting(b, f, "slug", nonEmpty(fail), fail);
  const installationId = setting(b, f, "installationId", positiveInt(fail), fail);
  const botUserId = setting(b, f, "botUserId", positiveInt(fail), fail);
  const tokens = setting(
    b,
    f,
    "tokens",
    (v, field) =>
      v === "devbox" || v === "external" ? v : fail(`${field}: must be "devbox" or "external"`),
    fail,
  );
  const tokenScope = b.obj.tokenScope === undefined ? "repos" : b.obj.tokenScope;
  if (tokenScope !== "repos" && tokenScope !== "installation") {
    return fail(`${f}.tokenScope: must be "repos" or "installation"`);
  }
  const ciResults = b.obj.ciResults === undefined ? true : b.obj.ciResults;
  if (typeof ciResults !== "boolean") return fail(`${f}.ciResults: must be true or false`);
  const org = b.obj.org === undefined ? undefined : nonEmpty(fail)(b.obj.org, `${f}.org`);
  const pending = b.obj.pending === undefined ? undefined : parsePending(b.obj.pending, fail);
  let tokenFile: string | undefined;
  if (b.obj.tokenFile !== undefined) {
    if (platform === "k8s") {
      return fail(`${f}.tokenFile: Compose only; on Kubernetes use secrets.github.existingSecret`);
    }
    tokenFile = nonEmpty(fail)(b.obj.tokenFile, `${f}.tokenFile`);
    if (!tokenFile.startsWith("/")) return fail(`${f}.tokenFile: must be an absolute path`);
    const bad = (why: string) => fail(`${f}.tokenFile ${tokenFile}: ${why}`);
    // Compose's short volume syntax splits on these.
    if (/[:,]/.test(tokenFile)) return bad(`the path can't contain ":" or ","`);
    const dir = dirname(resolve(tokenFile));
    if (dir === "/" || dir === resolve(homedir())) {
      return bad(
        "keep the token file in a directory of its own (its whole directory is mounted into the containers)",
      );
    }
  } else if (b.enabled && tokens === "external" && platform === "compose") {
    return fail(`${f}.tokenFile: required with tokens "external" on Compose`);
  }
  return {
    enabled: b.enabled,
    ...(appId !== undefined ? { appId } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(installationId !== undefined ? { installationId } : {}),
    ...(botUserId !== undefined ? { botUserId } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    tokenScope,
    ciResults,
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    ...(org !== undefined ? { org } : {}),
    ...(pending !== undefined ? { pending } : {}),
  };
}

function parsePending(raw: unknown, fail: Fail): PendingGithubApp {
  const f = "integrations.githubApp.pending";
  if (!isObject(raw)) return fail(`${f}: must be an object`);
  onlyKeys(raw, ["appId", "slug", "org", "publicUrl"], f, fail);
  const appId = positiveInt(fail)(raw.appId, `${f}.appId`);
  const slug = nonEmpty(fail)(raw.slug, `${f}.slug`);
  const org = raw.org === undefined ? undefined : nonEmpty(fail)(raw.org, `${f}.org`);
  const publicUrl =
    raw.publicUrl === undefined ? undefined : parsePublicUrl(raw.publicUrl, `${f}.publicUrl`, fail);
  return {
    appId,
    slug,
    ...(org !== undefined ? { org } : {}),
    ...(publicUrl !== undefined ? { publicUrl } : {}),
  };
}

// The shapes the control plane accepts (src/integrations/jira/config.ts).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const JIRA_ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\S*)?$/;

// The site as a bare https origin, as the control plane wants it; undefined
// for anything else.
export function jiraSiteOrigin(raw: string): string | undefined {
  const url = URL.parse(raw.trim());
  return url?.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
    ? url.origin
    : undefined;
}

export const isJiraDate = (v: string): boolean =>
  ISO_DATE.test(v) && !Number.isNaN(new Date(v).getTime());

function parseJira(raw: unknown, fail: Fail): JiraIntegration {
  const f = "integrations.jira";
  const b = block(
    raw,
    "jira",
    [
      "siteUrl",
      "cloudId",
      "botEmail",
      "botAccountId",
      "botName",
      "projectKeys",
      "trustedGroups",
      "trustedUsers",
      "statuses",
      "tokenExpiresAt",
      "allowRestrictedIssues",
    ],
    fail,
  );
  const shaped =
    (test: (v: string) => boolean, what: string) =>
    (v: unknown, field: string): string => {
      const s = nonEmpty(fail)(v, field);
      return test(s) ? s : fail(`${field}: must be ${what}`);
    };
  // A list of strings; `item` checks each.
  const strings =
    (item: (v: string) => boolean, what: string, nonEmptyList: boolean) =>
    (v: unknown, field: string): string[] =>
      Array.isArray(v) &&
      (v.length > 0 || !nonEmptyList) &&
      v.every((x) => typeof x === "string" && item(x))
        ? (v as string[])
        : fail(`${field}: must be a ${nonEmptyList ? "non-empty " : ""}list of ${what}`);
  const siteUrl = setting(
    b,
    f,
    "siteUrl",
    (v, field) =>
      (typeof v === "string" ? jiraSiteOrigin(v) : undefined) ??
      fail(`${field}: must be an https origin such as https://example.atlassian.net`),
    fail,
  );
  const cloudId = setting(
    b,
    f,
    "cloudId",
    shaped((s) => UUID.test(s), "a UUID"),
    fail,
  );
  const botEmail = setting(
    b,
    f,
    "botEmail",
    shaped((s) => /^[^\s@]+@[^\s@]+$/.test(s), "an email address"),
    fail,
  );
  const botAccountId = setting(
    b,
    f,
    "botAccountId",
    shaped((s) => JIRA_ACCOUNT_ID.test(s), "a Jira account id"),
    fail,
  );
  const botName = setting(b, f, "botName", nonEmpty(fail), fail);
  const projectKeys = setting(
    b,
    f,
    "projectKeys",
    strings((s) => JIRA_PROJECT_KEY.test(s), "project keys such as ENG", true),
    fail,
  );
  const tokenExpiresAt = setting(
    b,
    f,
    "tokenExpiresAt",
    shaped(isJiraDate, "a date such as 2027-01-31"),
    fail,
  );
  // Only commas separate group names in JIRA_TRUSTED_GROUPS; names may hold spaces.
  const optional = <T>(key: string, parse: (v: unknown, field: string) => T): T | undefined =>
    b.obj[key] === undefined ? undefined : parse(b.obj[key], `${f}.${key}`);
  const trustedGroups = optional(
    "trustedGroups",
    strings((s) => s.trim() !== "" && !s.includes(","), "group names without commas", false),
  );
  const trustedUsers = optional(
    "trustedUsers",
    strings((s) => JIRA_ACCOUNT_ID.test(s), "Jira account ids", false),
  );
  const statuses = optional("statuses", (v, field) => {
    if (!isObject(v)) return fail(`${field}: must be an object`);
    onlyKeys(v, ["started", "done", "failed"], field, fail);
    const out: JiraStatuses = {};
    for (const key of ["started", "done", "failed"] as const) {
      if (v[key] !== undefined) out[key] = nonEmpty(fail)(v[key], `${field}.${key}`);
    }
    return out;
  });
  const allowRestricted = optional("allowRestrictedIssues", (v, field) =>
    typeof v === "boolean" ? v : fail(`${field}: must be true or false`),
  );
  return {
    enabled: b.enabled,
    ...(siteUrl !== undefined ? { siteUrl } : {}),
    ...(cloudId !== undefined ? { cloudId } : {}),
    ...(botEmail !== undefined ? { botEmail } : {}),
    ...(botAccountId !== undefined ? { botAccountId } : {}),
    ...(botName !== undefined ? { botName } : {}),
    ...(projectKeys !== undefined ? { projectKeys } : {}),
    ...(trustedGroups !== undefined ? { trustedGroups } : {}),
    ...(trustedUsers !== undefined ? { trustedUsers } : {}),
    ...(statuses !== undefined ? { statuses } : {}),
    ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
    ...(allowRestricted !== undefined ? { allowRestrictedIssues: allowRestricted } : {}),
  };
}

const K8S_ONLY = ["slack"] as const;

export function parseIntegrations(
  raw: unknown,
  fail: Fail,
  opts: { platform: "compose" | "k8s" },
): Integrations {
  if (raw === undefined) return {};
  if (!isObject(raw)) return fail("integrations: must be an object");
  if ("githubWebhooks" in raw) {
    return fail(
      "integrations.githubWebhooks: replaced by integrations.githubApp; run bun run github:setup",
    );
  }
  if (opts.platform === "compose") {
    const k8sOnly = K8S_ONLY.find((name) => name in raw);
    if (k8sOnly)
      return fail(`integrations.${k8sOnly}: supported on Kubernetes only (the target file)`);
    onlyKeys(raw, ["linear", "githubApp", "jira"], "integrations", fail);
  } else {
    onlyKeys(raw, ["linear", ...K8S_ONLY, "githubApp", "jira"], "integrations", fail);
  }
  const out: Integrations = {};
  if (raw.linear !== undefined) out.linear = parseLinear(raw.linear, fail);
  if (raw.slack !== undefined) out.slack = parseSlack(raw.slack, fail);
  if (raw.githubApp !== undefined) {
    out.githubApp = parseGithubApp(raw.githubApp, fail, opts.platform);
  }
  if (raw.jira !== undefined) out.jira = parseJira(raw.jira, fail);
  return out;
}
