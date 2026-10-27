// What the scripts need around a configured GitHub App: the commit identity
// of its bot, whether its installation covers the configured repos, where the
// installation's settings are, a check that the App id names it, a guard
// for a private key GitHub rejects, a token minted for checks, and
// the external mode's token file. Never prints a key, JWT or token.
import { readFileSync } from "node:fs";
import { appJwt } from "../../src/githubToken/jwt";
import {
  type Fetch,
  GithubAppError,
  githubApiBaseUrl,
  githubAppFetch,
  mintInstallationToken,
} from "../../src/githubToken/mint";
import type { RepoConfig } from "../up/config";
import type { Identity } from "../up/preflight";
import { PrivateKeyError } from "./githubAppKey";
import type { EnabledGithubApp } from "./integrations";

// The ` --target <file>` a Kubernetes deployment's commands take; empty on Compose.
const targetFlag = (target?: string): string => (target ? ` --target ${target}` : "");

export const missingKeyMessage = (target?: string): string =>
  `No private key for the GitHub App: set GITHUB_APP_PRIVATE_KEY_FILE to its path, or run bun run github:setup${targetFlag(target)}`;

export class GithubAppSetupError extends Error {}

// Commits link to the App's bot on GitHub: its login is `<slug>[bot]`, and the
// noreply address carries the bot's user id (not the App's id).
export function appIdentity(slug: string, botUserId: number): Identity {
  return {
    gitName: `${slug}[bot]`,
    gitEmail: `${botUserId}+${slug}[bot]@users.noreply.github.com`,
  };
}

export type InstallationAccount = { login: string; type: string };

// The page where repos are added to the installation. It depends on the
// account the App is installed on; without it, the App's own page lists its
// installations, each with a Configure link.
export function installationSettingsUrl(
  app: Pick<EnabledGithubApp, "slug" | "installationId">,
  account?: InstallationAccount,
): string {
  if (!account) return `https://github.com/apps/${app.slug}/installations/new`;
  return account.type === "Organization"
    ? `https://github.com/organizations/${account.login}/settings/installations/${app.installationId}`
    : `https://github.com/settings/installations/${app.installationId}`;
}

// The account the installation belongs to, for installationSettingsUrl.
// Undefined when GitHub doesn't say.
export async function installationAccount(
  app: Pick<EnabledGithubApp, "appId" | "installationId">,
  pem: string,
  fetch: Fetch,
): Promise<InstallationAccount | undefined> {
  try {
    const out = (await githubAppFetch(
      `/app/installations/${app.installationId}`,
      { method: "GET", jwt: () => appJwt(app.appId, pem, new Date()) },
      { fetch, apiBase: githubApiBaseUrl() },
    )) as { account?: { login?: unknown; type?: unknown } } | null;
    const { login, type } = out?.account ?? {};
    return typeof login === "string" && typeof type === "string" ? { login, type } : undefined;
  } catch {
    return undefined;
  }
}

// The configured repos ("owner/name") the App's installation does not cover:
// GitHub answers 404, or names another installation of the App. Other
// refusals are thrown (a 401 means GitHub rejected the key).
export async function checkCoverage(
  app: Pick<EnabledGithubApp, "appId" | "installationId">,
  pem: string,
  repos: RepoConfig[],
  fetch: Fetch,
): Promise<string[]> {
  const uncovered: string[] = [];
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    try {
      const out = (await githubAppFetch(
        `/repos/${slug}/installation`,
        { method: "GET", jwt: () => appJwt(app.appId, pem, new Date()) },
        { fetch, apiBase: githubApiBaseUrl() },
      )) as { id?: unknown } | null;
      if (out?.id !== app.installationId) uncovered.push(slug);
    } catch (err) {
      if (err instanceof GithubAppError && err.status === 404) uncovered.push(slug);
      else throw err;
    }
  }
  return uncovered;
}

export const coverageMessage = (uncovered: string[], settingsUrl: string): string =>
  `These repos are not in the GitHub App's installation: ${uncovered.join(", ")}. Add them at ${settingsUrl}, or run with tokenScope "installation"`;

// How to replace a wrong key that came from the keychain or env, for the
// rejected-credentials message. `target` is a Kubernetes deployment's target file.
export const savedKeyFix = (target?: string): string => {
  const flag = targetFlag(target);
  return `run bun run secrets rm GITHUB_APP_PRIVATE_KEY${flag}, then bun run github:setup${flag}.`;
};

// Runs a call signed with the App's key. A 401 can mean a skewed host clock
// (the JWT's times), a wrong App id or a wrong key, and the saved key may be
// the only copy, so it is never removed or asked for again: the run stops
// naming what to check. `keyFix` says how to replace the key where it came from.
export async function callWithAppKey<T>(
  call: () => Promise<T>,
  keyFix: string = savedKeyFix(),
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof GithubAppError) || err.status !== 401) throw err;
    throw new PrivateKeyError(
      `GitHub rejected the App's credentials: ${err.reason || "HTTP 401"}. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, ${keyFix}`,
    );
  }
}

// Where the key came from, for the messages: a Kubernetes deployment's target
// file, and how to replace a wrong key (savedKeyFix by default). `rejected`
// replaces the whole message for credentials GitHub rejects, `notFound` the
// one for an App id GitHub doesn't know.
export type KeyOrigin = {
  target?: string;
  keyFix?: string;
  rejected?: (reason: string) => string;
  notFound?: string;
};

// The App's settings page, which holds its webhook URL and private keys.
export const appSettingsUrl = (slug: string, owner?: InstallationAccount): string =>
  owner?.type === "Organization"
    ? `https://github.com/organizations/${owner.login}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;

export type AppInfo = { slug: string; htmlUrl: string; owner?: InstallationAccount };

// That the App id names the configured App, before any call that depends on
// it: for a JWT signed for an id no App has, GitHub answers 404, which the
// coverage check would read as an uncovered repo and the mint as a missing
// installation. Without a configured slug (an App being adopted), GitHub's
// is taken. Returns what GitHub says about the App.
export async function verifyApp(
  app: { appId: number; slug?: string },
  pem: string,
  fetch: Fetch,
  origin: KeyOrigin = {},
): Promise<AppInfo> {
  const { target, rejected } = origin;
  const call = () =>
    githubAppFetch(
      "/app",
      { method: "GET", jwt: () => appJwt(app.appId, pem, new Date()) },
      { fetch, apiBase: githubApiBaseUrl() },
    );
  let out: { slug?: unknown; html_url?: unknown; owner?: unknown } | null;
  try {
    out = (await (rejected
      ? call().catch((err: unknown) => {
          if (err instanceof GithubAppError && err.status === 401) {
            throw new PrivateKeyError(rejected(err.reason || "HTTP 401"));
          }
          throw err;
        })
      : callWithAppKey(call, origin.keyFix ?? savedKeyFix(target)))) as typeof out;
  } catch (err) {
    if (!(err instanceof GithubAppError)) throw err;
    if (err.status === 404) {
      throw new GithubAppSetupError(
        origin.notFound ??
          `GitHub has no App with id ${app.appId}: check integrations.githubApp.appId (the App's settings page shows its App ID)`,
      );
    }
    throw new GithubAppSetupError(`checking the GitHub App failed: ${err.message}`);
  }
  const slug = typeof out?.slug === "string" && out.slug ? out.slug : undefined;
  if (app.slug === undefined && slug === undefined) {
    throw new GithubAppSetupError(`GitHub's answer for App ${app.appId} names no slug`);
  }
  if (app.slug !== undefined && slug !== app.slug) {
    const actual = slug
      ? `App ${app.appId} is "${slug}"`
      : `GitHub's answer for App ${app.appId} names no slug`;
    throw new GithubAppSetupError(
      `integrations.githubApp.slug is "${app.slug}" but ${actual}: run bun run github:setup${targetFlag(target)}`,
    );
  }
  const found = slug as string;
  const o = out?.owner as { login?: unknown; type?: unknown } | undefined;
  const owner =
    typeof o?.login === "string" && typeof o.type === "string"
      ? { login: o.login, type: o.type }
      : undefined;
  return {
    slug: found,
    htmlUrl: typeof out?.html_url === "string" ? out.html_url : `https://github.com/apps/${found}`,
    ...(owner ? { owner } : {}),
  };
}

// The repos' names, the list a token is narrowed to with tokenScope "repos".
export const appRepositories = (repos: RepoConfig[]): string[] => repos.map((r) => r.name);

// One token minted with the App's key, for the scripts' own checks. First,
// that the App id and slug match (verifyApp); then, when asked, that the
// installation covers every repo: a token narrowed to a
// repo outside it is refused as a whole. Credentials GitHub rejects stop the
// run (callWithAppKey); its other refusals name the call.
export async function mintAppToken(
  app: EnabledGithubApp,
  pem: string,
  repos: RepoConfig[],
  opts: { fetch: Fetch; checkCoverage: boolean } & KeyOrigin,
): Promise<{ token: string; expiresAt: string }> {
  const { fetch } = opts;
  const keyFix = opts.keyFix ?? savedKeyFix(opts.target);
  const withKey = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await callWithAppKey(call, keyFix);
    } catch (err) {
      if (err instanceof GithubAppError) {
        throw new GithubAppSetupError(`${what} failed: ${err.message}`);
      }
      throw err;
    }
  };
  await verifyApp(app, pem, fetch, { target: opts.target, keyFix });
  if (opts.checkCoverage) {
    const uncovered = await withKey("checking the GitHub App's installation", () =>
      checkCoverage(app, pem, repos, fetch),
    );
    if (uncovered.length > 0) {
      const account = await installationAccount(app, pem, fetch);
      throw new GithubAppSetupError(
        coverageMessage(uncovered, installationSettingsUrl(app, account)),
      );
    }
  }
  return withKey("minting a GitHub App token", () =>
    mintInstallationToken({
      appId: app.appId,
      installationId: app.installationId,
      privateKeyPem: pem,
      repositories: app.tokenScope === "repos" ? appRepositories(repos) : [],
      fetch,
    }),
  );
}

// The external mode's token, read once for the checks and the repos volume.
export function readTokenFile(path: string): string {
  const fail = (why: string) =>
    new GithubAppSetupError(`integrations.githubApp.tokenFile ${path}: ${why}`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw fail(
      code === "EISDIR"
        ? "is a directory"
        : code === "ENOENT"
          ? "not found"
          : code === "EACCES"
            ? "permission denied"
            : "cannot read it",
    );
  }
  const token = text.trim();
  if (!token) throw fail("is empty");
  return token;
}
