// Checks before startup for a GitLab instance: it answers, the token is
// accepted and identifies the bot, and for each repo under it the project
// exists, the token can push (git's push advertisement, which writes nothing)
// and can open merge requests (a request for one from a branch that does not
// exist: GitLab checks the permission before the branch). With the webhooks
// on, the reads the control plane and the harness need: pipelines and jobs
// of each project, the members of each trusted group. Each failure names the
// setting or, for a fine-grained token, the permission GitLab asked for. The
// token never appears in a message.
import { randomBytes } from "node:crypto";
import type { GitlabConfig, RepoConfig } from "../up/config";
import { CredentialRejected, type Fetch, type Identity, PreflightError } from "../up/preflight";

export type GitlabIdentity = {
  // 0 and "" when the token may not read /api/v4/user and no identity was
  // configured: a gitlab.com fine-grained token without "User: Read".
  id: number;
  username: string;
  name: string;
  // A bot user (a group or project access token's), as opposed to a person.
  bot: boolean;
  // The instance's version, "19.5.3"; "" when the token may not read it.
  version: string;
};

export const identityKnown = (i: Pick<GitlabIdentity, "id">): boolean => i.id > 0;

export class GitlabCheckError extends PreflightError {}

export type CheckGitlabOptions = {
  requirePush?: boolean;
  // The PEM of the instance's private CA (gitlab.caFile), for this check's
  // own connections.
  ca?: string;
  headName?: () => string;
  // With the webhooks on: the groups whose member lists the trust gate reads.
  webhooks?: { trustedGroups: string[] };
  // How messages name the token.
  tokenName?: string;
  // The bot as configured (integrations.gitlab, or --bot-username/--bot-user-id):
  // used when the token may not read /api/v4/user (a gitlab.com fine-grained
  // token without "User: Read"), which is a permission gap, not a bad token.
  identity?: { id: number; username: string };
};

// The signing token (webhook-signature) became generally available in 19.1.
export const SIGNING_TOKEN_MIN_VERSION = "19.1";

const DOCS = "see docs/gitlab.md#what-you-need";

export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(version), parse(min)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return true;
}

const enc = (owner: string, name: string) => encodeURIComponent(`${owner}/${name}`);

type Api = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ res: Response; why: string }>;

// GitLab's reason: `message` (a string or a list) or, for a fine-grained
// token, `error_description`, which names the missing permission.
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const p = parsed as { message?: unknown; error_description?: unknown; error?: unknown };
      const m = p.error_description ?? p.message ?? p.error ?? "";
      message = Array.isArray(m) ? m.join("; ") : String(m);
    }
  } catch {}
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

const withReason = (status: number, why: string) => `${status}${why ? `: ${why}` : ""}`;

// Lets go of a body nobody read; one `reason` already consumed is left alone.
async function drain(res: Response): Promise<void> {
  if (res.body && !res.bodyUsed) await res.body.cancel().catch(() => {});
}

// A fine-grained token's refusal names the permission to add.
function permissionHint(why: string): string {
  const m = /permissions?: \[([^\]]+)\]/.exec(why);
  return m ? ` (add the permission ${m[1]} to the token)` : "";
}

function tlsHint(message: string, hasCa: boolean): string {
  if (!/certificate|self[ -]signed|UNABLE_TO|CERT_|SSL|TLS/i.test(message)) return "";
  return hasCa
    ? " (the instance's certificate does not chain to gitlab.caFile)"
    : " (a private CA? set gitlab.caFile in devbox.config.json to its PEM)";
}

function apiFor(base: string, token: string, fetch: Fetch, ca: string | undefined): Api {
  return async (method, path, body) => {
    const url = path.startsWith("https://") || path.startsWith("http://") ? path : `${base}${path}`;
    const init: RequestInit & { tls?: { ca: string } } = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "devbox-setup",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      ...(ca ? { tls: { ca } } : {}),
    };
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const message = (err as Error).message;
      throw new GitlabCheckError(
        `GitLab check failed: ${method} ${url}: ${message}${tlsHint(message, ca !== undefined)}`,
      );
    }
    return { res, why: res.ok ? "" : await reason(res) };
  };
}

async function checkPush(
  api: Api,
  base: string,
  token: string,
  tokenName: string,
  repo: RepoConfig,
  i: number,
  fetch: Fetch,
  ca: string | undefined,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const url = `${base}/${slug}.git/info/refs?service=git-receive-pack`;
  const basic = Buffer.from(`oauth2:${token}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Basic ${basic}`, "User-Agent": "git/devbox-setup" },
      redirect: "manual",
      ...(ca ? { tls: { ca } } : {}),
    } as RequestInit);
  } catch (err) {
    throw new GitlabCheckError(`GitLab check failed: GET ${url}: ${(err as Error).message}`);
  }
  if (res.status === 200) {
    await drain(res);
    return;
  }
  if (res.status >= 300 && res.status < 400) {
    await drain(res);
    const to = res.headers.get("location");
    throw new GitlabCheckError(
      `${slug} (repos[${i}]) has moved${to ? ` to ${to}` : ""}: update repos[${i}].url`,
    );
  }
  const why = await reason(res);
  void api;
  throw new GitlabCheckError(
    `${tokenName} cannot push to ${slug} (repos[${i}]): git's push endpoint returned ${withReason(res.status, why)}; the token needs the write_repository scope (or Code: Push) and the Developer role (${DOCS})`,
  );
}

async function checkMergeRequests(
  api: Api,
  tokenName: string,
  repo: RepoConfig,
  i: number,
  head: string,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const path = `/api/v4/projects/${enc(repo.owner, repo.name)}/merge_requests`;
  const { res, why } = await api("POST", path, {
    source_branch: head,
    target_branch: repo.branch,
    title: "devbox preflight check (never created)",
  });
  // The branch does not exist: GitLab answers 400 (or 409/422) once the
  // permission check passed. 403 is the refusal.
  if (res.status === 400 || res.status === 409 || res.status === 422) {
    await drain(res);
    return;
  }
  if (res.status === 201) {
    const mr = (await res.json().catch(() => ({}))) as { iid?: number; web_url?: string };
    if (typeof mr.iid === "number") {
      await api("PUT", `${path}/${mr.iid}`, { state_event: "close" });
    }
    throw new GitlabCheckError(
      `the merge request check opened a real merge request in ${slug}, because branch ${head} exists: it was closed; delete ${mr.web_url ?? "it"} by hand`,
    );
  }
  throw new GitlabCheckError(
    `${tokenName} cannot open merge requests in ${slug} (repos[${i}]): POST ${path} returned ${withReason(res.status, why)}${permissionHint(why)}; the token needs the api scope (or Merge Request: Create) (${DOCS})`,
  );
}

export async function checkGitlab(
  instance: Pick<GitlabConfig, "baseUrl">,
  token: string,
  repos: RepoConfig[],
  fetch: Fetch,
  opts: CheckGitlabOptions = {},
): Promise<GitlabIdentity> {
  const tokenName = opts.tokenName ?? "GITLAB_TOKEN";
  const base = instance.baseUrl;
  if (!token) {
    throw new GitlabCheckError(
      `${tokenName} is empty: devbox needs a token that can push to the repos`,
    );
  }
  const api = apiFor(base, token, fetch, opts.ca);

  // 1. The instance, and the token with it. A 403 is not a rejection: on
  // gitlab.com a fine-grained token without the instance permission
  // "Metadata: Read" may not read the version yet does everything else; the
  // version then stays unknown ("") and the user lookup decides the token.
  const v = await api("GET", "/api/v4/version");
  if (v.res.status === 401) {
    throw new CredentialRejected(
      `GitLab rejected ${tokenName} (GET /api/v4/version returned ${withReason(v.res.status, v.why)}): check the token and its expiry on ${base}`,
    );
  }
  if (!v.res.ok && v.res.status !== 403) {
    throw new GitlabCheckError(
      `GitLab check failed: GET ${base}/api/v4/version returned ${withReason(v.res.status, v.why)}: is gitlab.baseUrl right?`,
    );
  }
  const version = v.res.ok
    ? String(((await v.res.json().catch(() => ({}))) as { version?: unknown }).version ?? "")
    : "";

  // 2. Who the token is. A 403 is a permission gap, not a bad token: a
  // gitlab.com fine-grained token without "User: Read" still pushes and opens
  // merge requests. The configured identity stands in when there is one;
  // otherwise the identity stays unknown and the repo checks below decide.
  const u = await api("GET", "/api/v4/user");
  let user: { id?: unknown; username?: unknown; name?: unknown; bot?: unknown };
  if (u.res.status === 403) {
    user = opts.identity
      ? { id: opts.identity.id, username: opts.identity.username }
      : { id: 0, username: "" };
  } else if (!u.res.ok) {
    const Err = u.res.status === 401 ? CredentialRejected : GitlabCheckError;
    throw new Err(
      `GitLab rejected ${tokenName} (GET /api/v4/user returned ${withReason(u.res.status, u.why)})${permissionHint(u.why)}; the token needs the api scope (or User: Read)`,
    );
  } else {
    user = (await u.res.json()) as typeof user;
  }
  const id = Number(user.id);
  if (!Number.isFinite(id) || typeof user.username !== "string") {
    throw new GitlabCheckError(
      "GitLab check failed: GET /api/v4/user answered without id and username",
    );
  }
  const identity: GitlabIdentity = {
    id,
    username: user.username,
    name: typeof user.name === "string" ? user.name : user.username,
    bot: user.bot === true,
    version,
  };

  // 3. Each repo under the instance.
  const headName = opts.headName ?? (() => `devbox-preflight-${randomBytes(8).toString("hex")}`);
  for (const [i, repo] of repos.entries()) {
    const slug = `${repo.owner}/${repo.name}`;
    const p = await api("GET", `/api/v4/projects/${enc(repo.owner, repo.name)}`);
    if (!p.res.ok) {
      throw new GitlabCheckError(
        `${slug} (repos[${i}]) does not exist or ${tokenName} cannot see it (GET /api/v4/projects/${slug} returned ${withReason(p.res.status, p.why)})${permissionHint(p.why)}`,
      );
    }
    await drain(p.res);
    if (opts.requirePush === false) continue;
    await checkPush(api, base, token, tokenName, repo, i, fetch, opts.ca);
    await checkMergeRequests(api, tokenName, repo, i, headName());
  }

  // 4. The webhooks' reads: pipelines and jobs per project, members per group.
  if (opts.webhooks) {
    for (const [i, repo] of repos.entries()) {
      const slug = `${repo.owner}/${repo.name}`;
      for (const [what, path, permission] of [
        ["pipelines", "pipelines", "Pipeline: Read"],
        ["jobs", "jobs", "Job: Read"],
      ] as const) {
        const r = await api(
          "GET",
          `/api/v4/projects/${enc(repo.owner, repo.name)}/${path}?per_page=1`,
        );
        if (!r.res.ok) {
          throw new GitlabCheckError(
            `${tokenName} cannot read the ${what} of ${slug} (repos[${i}]): returned ${withReason(r.res.status, r.why)}${permissionHint(r.why) || ` (the token needs ${permission})`}; CI results need it`,
          );
        }
        await drain(r.res);
      }
    }
    for (const group of opts.webhooks.trustedGroups) {
      const r = await api(
        "GET",
        `/api/v4/groups/${encodeURIComponent(group)}/members/all?per_page=1`,
      );
      if (!r.res.ok) {
        const detail =
          r.res.status === 404
            ? "the group does not exist or the token cannot see it"
            : `returned ${withReason(r.res.status, r.why)}${permissionHint(r.why) || " (the token needs Member: Read)"}`;
        throw new GitlabCheckError(
          `${tokenName} cannot list the members of group ${group} (gitlab.trustedGroups): ${detail}; the trust gate needs it`,
        );
      }
      const members = (await r.res.json().catch(() => [])) as unknown[];
      if (!Array.isArray(members) || members.length === 0) {
        throw new GitlabCheckError(
          `group ${group} (gitlab.trustedGroups) has no members: the trust gate would admit no one`,
        );
      }
    }
  }
  return identity;
}

// The webhooks drop the bot's own notes by integrations.gitlab.botUserId and
// mention it by botUsername: a token for another account would make every note
// on a new merge request look foreign.
export function botMismatch(
  gitlab: { botUsername: string; botUserId: number },
  identity: { username: string; id: number },
): string | undefined {
  if (gitlab.botUserId === identity.id && gitlab.botUsername === identity.username)
    return undefined;
  return `integrations.gitlab names the bot ${gitlab.botUsername} (id ${gitlab.botUserId}), but the GitLab token belongs to ${identity.username} (id ${identity.id}).`;
}

// The commit identity when there is no GitHub identity to borrow: the GitLab
// user's name and GitLab's private commit email form
// (<id>-<username>@users.noreply.<host>), which GitLab attributes to that user.
// None when the token may not read its own user.
export function gitlabCommitIdentity(
  instance: Pick<GitlabConfig, "baseUrl">,
  identity: GitlabIdentity,
): Identity | undefined {
  if (!identityKnown(identity)) return undefined;
  const host = new URL(instance.baseUrl).hostname;
  return {
    gitName: identity.name || identity.username,
    gitEmail: `${identity.id}-${identity.username}@users.noreply.${host}`,
  };
}
