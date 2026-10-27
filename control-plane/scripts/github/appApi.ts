// The GitHub calls `github:setup` makes for the App itself. The manifest
// conversion and the bot lookup are unauthenticated; the rest are signed
// with the App's JWT, signed afresh for every call, since the installation
// wait can outlast one JWT. The conversion's answer holds the App's private
// key and webhook secret, so its errors never quote the answer.
import { appJwt } from "../../src/githubToken/jwt";
import { type Fetch, GITHUB_TIMEOUT_MS, githubAppFetch } from "../../src/githubToken/mint";

export class AppApiError extends Error {}

export type AppAccount = { login: string; type: string };

export type ConvertedApp = {
  id: number;
  slug: string;
  pem: string;
  webhookSecret: string | null;
  htmlUrl: string;
  owner: AppAccount;
};

export type Installation = { id: number; account: AppAccount };

// The App's id and private key, for signing.
export type AppKey = { appId: number; pem: string };

export type AppApiDeps = { fetch: Fetch; apiBase: string; now: () => Date };

const AGAIN = "run bun run github:setup again";
const PER_PAGE = 100;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const account = (v: unknown): AppAccount | undefined =>
  isObject(v) && typeof v.login === "string" && typeof v.type === "string"
    ? { login: v.login, type: v.type }
    : undefined;

export type AppApi = ReturnType<typeof appApi>;

export function appApi(deps: AppApiDeps) {
  const http = { fetch: deps.fetch, apiBase: deps.apiBase };
  const signed = (key: AppKey) => () => appJwt(key.appId, key.pem, deps.now());

  return {
    // Trades the one-time code from GitHub's redirect for the new App's
    // credentials.
    async convertManifest(code: string): Promise<ConvertedApp> {
      const res = await deps.fetch(
        `${deps.apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        },
      );
      const text = await res.text();
      if (!res.ok) {
        throw new AppApiError(
          `GitHub didn't create the App from its manifest (HTTP ${res.status}): ${AGAIN}`,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new AppApiError(`GitHub's answer for the new App is not JSON: ${AGAIN}`);
      }
      const missing = (field: string) =>
        new AppApiError(`GitHub's answer for the new App has no usable ${field}: ${AGAIN}`);
      if (!isObject(body)) throw missing("App");
      const { id, slug, pem, webhook_secret: secret, html_url: htmlUrl } = body;
      if (typeof id !== "number") throw missing("id");
      if (typeof slug !== "string" || !slug) throw missing("slug");
      if (typeof pem !== "string" || !pem) throw missing("pem");
      if (typeof htmlUrl !== "string") throw missing("html_url");
      const owner = account(body.owner);
      if (!owner) throw missing("owner");
      return {
        id,
        slug,
        pem,
        webhookSecret: typeof secret === "string" && secret ? secret : null,
        htmlUrl,
        owner,
      };
    },

    // Every installation, a page of 100 at a time.
    async listInstallations(key: AppKey): Promise<Installation[]> {
      const all: Installation[] = [];
      for (let page = 1; ; page++) {
        const out = await githubAppFetch(
          `/app/installations?per_page=${PER_PAGE}&page=${page}`,
          { method: "GET", jwt: signed(key) },
          http,
        );
        const items = Array.isArray(out) ? out : [];
        for (const i of items) {
          const acc = isObject(i) ? account(i.account) : undefined;
          if (isObject(i) && typeof i.id === "number" && acc) all.push({ id: i.id, account: acc });
        }
        if (items.length < PER_PAGE) return all;
      }
    },

    // The App's bot user: its id goes into the commit e-mail. A JWT can't
    // call /users, so this one is unauthenticated.
    async getBotUserId(slug: string): Promise<number> {
      const login = `${slug}[bot]`;
      const out = await githubAppFetch(
        `/users/${encodeURIComponent(login)}`,
        { method: "GET" },
        http,
      );
      if (!isObject(out) || typeof out.id !== "number") {
        throw new AppApiError(`GitHub has no user id for ${login}`);
      }
      return out.id;
    },

    // Sets the App's webhook URL and/or secret; nothing else is sent.
    async updateHookConfig(key: AppKey, config: { url?: string; secret?: string }): Promise<void> {
      await githubAppFetch(
        "/app/hook/config",
        {
          method: "PATCH",
          jwt: signed(key),
          body: {
            ...(config.url !== undefined ? { url: config.url } : {}),
            ...(config.secret !== undefined ? { secret: config.secret } : {}),
          },
        },
        http,
      );
    },
  };
}
