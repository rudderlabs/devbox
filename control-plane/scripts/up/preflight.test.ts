import { describe, expect, it } from "bun:test";
import { parseConfig } from "./config";
import { CredentialRejected, checkGithub, checkLlm, type Fetch, PreflightError } from "./preflight";

type Req = { method: string; url: string; headers: Record<string, string>; body?: unknown };

// A fetch that answers from `routes` ("METHOD url" -> [status, json, headers?])
// and records requests.
function fakeFetch(
  routes: Record<string, [number, unknown] | [number, unknown, Record<string, string>] | Error>,
): {
  fetch: Fetch;
  requests: Req[];
} {
  const requests: Req[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const route = routes[`${method} ${url}`];
    if (route instanceof Error) throw route;
    if (!route) return new Response("not routed", { status: 599 });
    return Response.json(route[1], { status: route[0], headers: route[2] });
  };
  return { fetch, requests };
}

const cfg = parseConfig({
  repos: [{ url: "https://github.com/a/x.git" }, { url: "https://github.com/b/y.git" }],
  llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
});

const anthropicCfg = parseConfig({
  repos: [{ url: "https://github.com/a/x.git" }],
  llm: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" },
});

const USER = "GET https://api.github.com/user";
const REPO_X = "GET https://api.github.com/repos/a/x";
const REPO_Y = "GET https://api.github.com/repos/b/y";
const PUSH_X = "GET https://github.com/a/x.git/info/refs?service=git-receive-pack";
const PUSH_Y = "GET https://github.com/b/y.git/info/refs?service=git-receive-pack";
const PULLS_X = "POST https://api.github.com/repos/a/x/pulls";
const PULLS_Y = "POST https://api.github.com/repos/b/y/pulls";
const RESPONSES = "POST https://api.openai.com/v1/responses";
const MESSAGES = "POST https://api.anthropic.com/v1/messages";
const user = { id: 42, login: "octo", name: "Octo Cat" };
const repo = { full_name: "a/x" };
const advert = "001f# service=git-receive-pack\n";
const invalidHead = {
  message: "Validation Failed",
  errors: [{ resource: "PullRequest", field: "head", code: "invalid" }],
};
const prForbidden = { message: "Resource not accessible by personal access token" };
const HEAD = "devbox-preflight-0123456789abcdef";
const headName = () => HEAD;
const DOCS = "see docs/configuration.md#what-preflight-checks";

// Every check passes for both repos.
const writable = {
  [REPO_X]: [200, repo],
  [PUSH_X]: [200, advert],
  [PULLS_X]: [422, invalidHead],
  [REPO_Y]: [200, repo],
  [PUSH_Y]: [200, advert],
  [PULLS_Y]: [422, invalidHead],
} satisfies Record<string, [number, unknown]>;

describe("checkGithub", () => {
  it("checks the user, then each repo's visibility, push and pull requests, and returns the commit identity", async () => {
    const f = fakeFetch({ [USER]: [200, user], ...writable });
    expect(await checkGithub("ghp_t", cfg.repos, f.fetch, { headName })).toEqual({
      gitName: "Octo Cat",
      gitEmail: "42+octo@users.noreply.github.com",
    });
    const headers = {
      accept: "application/vnd.github+json",
      authorization: "Bearer ghp_t",
      "user-agent": "devbox-up",
      "x-github-api-version": "2022-11-28",
    };
    const git = {
      authorization: `Basic ${Buffer.from("x-access-token:ghp_t").toString("base64")}`,
      "user-agent": "git/devbox-up",
    };
    const pulls = (base: string) => ({
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: { title: "devbox preflight check (never created)", head: HEAD, base },
    });
    expect(f.requests).toEqual([
      { method: "GET", url: "https://api.github.com/user", headers },
      { method: "GET", url: "https://api.github.com/repos/a/x", headers },
      {
        method: "GET",
        url: "https://github.com/a/x.git/info/refs?service=git-receive-pack",
        headers: git,
      },
      { url: "https://api.github.com/repos/a/x/pulls", ...pulls("main") },
      { method: "GET", url: "https://api.github.com/repos/b/y", headers },
      {
        method: "GET",
        url: "https://github.com/b/y.git/info/refs?service=git-receive-pack",
        headers: git,
      },
      { url: "https://api.github.com/repos/b/y/pulls", ...pulls("main") },
    ]);
  });

  it("asks for the pull request against the configured branch", async () => {
    const dev = parseConfig({
      repos: [{ url: "https://github.com/a/x.git", branch: "develop" }],
      llm: { baseUrl: "https://openrouter.ai/api/v1", model: "m" },
    });
    const f = fakeFetch({ [USER]: [200, user], ...writable });
    await checkGithub("t", dev.repos, f.fetch, { headName });
    expect(f.requests.at(-1)?.body).toEqual({
      title: "devbox preflight check (never created)",
      head: HEAD,
      base: "develop",
    });
  });

  it("uses a fresh random head branch for each pull request check", async () => {
    const f = fakeFetch({ [USER]: [200, user], ...writable });
    await checkGithub("t", cfg.repos, f.fetch);
    const heads = f.requests
      .filter((r) => r.method === "POST")
      .map((r) => (r.body as { head: string }).head);
    expect(heads).toHaveLength(2);
    for (const head of heads) expect(head).toMatch(/^devbox-preflight-[0-9a-f]{16}$/);
    expect(heads[0]).not.toBe(heads[1]);
  });

  it("uses the login when the name is null, and drops quoting characters from a name", async () => {
    for (const [name, gitName] of [
      [null, "octo"],
      ["  ", "octo"],
      [`O'Brien "$x\`\\`, "OBrien x"],
    ] as const) {
      const f = fakeFetch({ [USER]: [200, { ...user, name }], ...writable });
      expect(await checkGithub("t", cfg.repos.slice(0, 1), f.fetch, { headName })).toEqual({
        gitName,
        gitEmail: "42+octo@users.noreply.github.com",
      });
    }
  });

  it("names GITHUB_TOKEN on 401", async () => {
    const f = fakeFetch({ [USER]: [401, { message: "Bad credentials" }] });
    await expect(checkGithub("bad", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError("GitHub rejected GITHUB_TOKEN (GET /user returned 401: Bad credentials)"),
    );
  });

  it("names the token it was given in every message", async () => {
    const tokenName = "the GitHub App's token";
    const appUser = [403, { message: "Resource not accessible by integration" }] as [
      number,
      unknown,
    ];
    await expect(checkGithub("", cfg.repos, fetch, { tokenName })).rejects.toThrow(
      new PreflightError(
        "the GitHub App's token is empty: devbox needs a token that can push to the repos",
      ),
    );
    let f = fakeFetch({ [USER]: [401, { message: "Bad credentials" }] });
    await expect(checkGithub("t", cfg.repos, f.fetch, { tokenName })).rejects.toThrow(
      new PreflightError(
        "GitHub rejected the GitHub App's token (GET /user returned 401: Bad credentials)",
      ),
    );
    f = fakeFetch({ [USER]: appUser, [REPO_X]: [404, { message: "Not Found" }] });
    await expect(checkGithub("t", cfg.repos, f.fetch, { tokenName })).rejects.toThrow(
      new PreflightError(
        "a/x (repos[0]) does not exist or the GitHub App's token cannot see it (GET /repos/a/x returned 404: Not Found)",
      ),
    );
    f = fakeFetch({ [USER]: appUser, ...writable, [PUSH_Y]: [403, "denied"] });
    await expect(checkGithub("t", cfg.repos, f.fetch, { tokenName, headName })).rejects.toThrow(
      new PreflightError(
        `the GitHub App's token cannot push to b/y (repos[1]): git's push endpoint returned 403: denied; check the token has Contents: read and write (${DOCS})`,
      ),
    );
    f = fakeFetch({ [USER]: appUser, ...writable, [PULLS_X]: [403, prForbidden] });
    await expect(checkGithub("t", cfg.repos, f.fetch, { tokenName, headName })).rejects.toThrow(
      new PreflightError(
        `the GitHub App's token cannot open pull requests in a/x (repos[0]): POST /repos/a/x/pulls returned 403: Resource not accessible by personal access token; check the token has Pull requests: read and write (${DOCS})`,
      ),
    );
    // An App token has no user: no identity, and every repo check passes.
    f = fakeFetch({ [USER]: appUser, ...writable });
    expect(await checkGithub("t", cfg.repos, f.fetch, { tokenName, headName })).toBeUndefined();
  });

  it("a /user 401 is a CredentialRejected", async () => {
    const saml = "Resource protected by organization SAML enforcement.";
    const cases: Array<[number, string, boolean]> = [
      [401, "Bad credentials", true],
      [403, saml, true],
      [500, "boom", false],
    ];
    for (const [status, message, rejected] of cases) {
      const f = fakeFetch({ [USER]: [status, { message }] });
      const err = await checkGithub("bad", cfg.repos, f.fetch).catch((e) => e);
      expect(err).toBeInstanceOf(PreflightError);
      expect(err instanceof CredentialRejected).toBe(rejected);
      expect(err.message).toBe(
        `GitHub rejected GITHUB_TOKEN (GET /user returned ${status}: ${message})`,
      );
    }
    // A repo the token cannot reach is a setting to fix, not a bad token.
    const f = fakeFetch({ [USER]: [200, user], [REPO_X]: [403, { message: saml }] });
    const err = await checkGithub("t", cfg.repos, f.fetch).catch((e) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect(err).not.toBeInstanceOf(CredentialRejected);
  });

  it("treats a 403 on /user as an installation token: no identity, every repo check still runs", async () => {
    const f = fakeFetch({
      [USER]: [403, { message: "Resource not accessible by integration" }],
      ...writable,
    });
    expect(await checkGithub("ghs_t", cfg.repos, f.fetch, { headName })).toBeUndefined();
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      USER,
      REPO_X,
      PUSH_X,
      PULLS_X,
      REPO_Y,
      PUSH_Y,
      PULLS_Y,
    ]);
  });

  it("accepts an installation token whose repo permissions all read false", async () => {
    // What GitHub returns for every App installation token, writable or not.
    const allFalse = { permissions: { admin: false, push: false, pull: false } };
    const f = fakeFetch({
      [USER]: [403, { message: "Resource not accessible by integration" }],
      ...writable,
      [REPO_X]: [200, allFalse],
      [REPO_Y]: [200, allFalse],
    });
    expect(await checkGithub("ghs_t", cfg.repos, f.fetch, { headName })).toBeUndefined();
  });

  it("refuses a token that cannot push, even when the repo reports push permission", async () => {
    // A read-only fine-grained PAT of a repo admin: `permissions.push` is true.
    const f = fakeFetch({
      [USER]: [200, user],
      ...writable,
      [REPO_Y]: [200, { permissions: { admin: true, push: true, pull: true } }],
      [PUSH_Y]: [403, "Write access to repository not granted."],
    });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        `GITHUB_TOKEN cannot push to b/y (repos[1]): git's push endpoint returned 403: Write access to repository not granted.; check the token has Contents: read and write (${DOCS})`,
      ),
    );
    expect(f.requests.map((r) => `${r.method} ${r.url}`).at(-1)).toBe(PUSH_Y);
  });

  it("refuses a token that can push but cannot open pull requests, with GitHub's reason", async () => {
    const f = fakeFetch({ [USER]: [200, user], ...writable, [PULLS_X]: [403, prForbidden] });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        `GITHUB_TOKEN cannot open pull requests in a/x (repos[0]): POST /repos/a/x/pulls returned 403: Resource not accessible by personal access token; check the token has Pull requests: read and write (${DOCS})`,
      ),
    );
  });

  it("passes on GitHub's reason when Actions may not open pull requests", async () => {
    const f = fakeFetch({
      [USER]: [403, { message: "Resource not accessible by integration" }],
      ...writable,
      [PULLS_X]: [
        403,
        { message: "GitHub Actions is not permitted to create or approve pull requests." },
      ],
    });
    await expect(checkGithub("ghs_t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        `GITHUB_TOKEN cannot open pull requests in a/x (repos[0]): POST /repos/a/x/pulls returned 403: GitHub Actions is not permitted to create or approve pull requests.; check the token has Pull requests: read and write (${DOCS})`,
      ),
    );
  });

  it("fails on an unexpected pull request check status, without a message", async () => {
    const f = fakeFetch({ [USER]: [200, user], ...writable, [PULLS_X]: [500, {}] });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        `GITHUB_TOKEN cannot open pull requests in a/x (repos[0]): POST /repos/a/x/pulls returned 500; check the token has Pull requests: read and write (${DOCS})`,
      ),
    );
  });

  it("closes a pull request the check opened by accident, and passes", async () => {
    const f = fakeFetch({
      [USER]: [200, user],
      ...writable,
      [PULLS_X]: [201, { number: 9 }],
      "PATCH https://api.github.com/repos/a/x/pulls/9": [200, {}],
    });
    await checkGithub("t", cfg.repos.slice(0, 1), f.fetch, { headName });
    expect(f.requests.at(-1)).toEqual({
      method: "PATCH",
      url: "https://api.github.com/repos/a/x/pulls/9",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer t",
        "content-type": "application/json",
        "user-agent": "devbox-up",
        "x-github-api-version": "2022-11-28",
      },
      body: { state: "closed" },
    });
  });

  it("rejects a 403 on /user that is not an installation token's, with GitHub's reason", async () => {
    const saml =
      "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.";
    const f = fakeFetch({ [USER]: [403, { message: saml }] });
    await expect(checkGithub("t", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError(`GitHub rejected GITHUB_TOKEN (GET /user returned 403: ${saml})`),
    );
  });

  it("reports a rate limit on /user instead of taking the token for an App token", async () => {
    const f = fakeFetch({
      [USER]: [
        403,
        { message: "API rate limit exceeded for user ID 42." },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792080000" },
      ],
    });
    await expect(checkGithub("t", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError(
        "GitHub rate limit hit (GET /user returned 403: API rate limit exceeded for user ID 42.); retry after 2026-10-15T16:00:00.000Z",
      ),
    );
  });

  it("reports a 429 on the pull request check as a rate limit, with Retry-After", async () => {
    const f = fakeFetch({
      [USER]: [200, user],
      ...writable,
      [PULLS_X]: [429, { message: "Too many requests" }, { "retry-after": "60" }],
    });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        "GitHub rate limit hit (POST /repos/a/x/pulls returned 429: Too many requests); retry in 60s",
      ),
    );
  });

  it("reports a secondary rate limit on the pull request check, not a missing permission", async () => {
    const message =
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
    const f = fakeFetch({ [USER]: [200, user], ...writable, [PULLS_X]: [403, { message }] });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(`GitHub rate limit hit (POST /repos/a/x/pulls returned 403: ${message})`),
    );
  });

  it("tells to update the URL of a repo that moved", async () => {
    const f = fakeFetch({
      [USER]: [200, user],
      ...writable,
      [PUSH_X]: [
        301,
        "",
        { location: "https://github.com/c/x.git/info/refs?service=git-receive-pack" },
      ],
    });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        "a/x (repos[0]) has moved to https://github.com/c/x.git/info/refs?service=git-receive-pack: update repos[0].url",
      ),
    );
  });

  it("passes on git's reason when the push endpoint refuses an archived repo", async () => {
    const f = fakeFetch({
      [USER]: [200, user],
      ...writable,
      [PUSH_X]: [403, "This repository was archived so it is read-only.\n"],
    });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        `GITHUB_TOKEN cannot push to a/x (repos[0]): git's push endpoint returned 403: This repository was archived so it is read-only.; check the token has Contents: read and write (${DOCS})`,
      ),
    );
  });

  it("passes on GitHub's reason when a repo is hidden by SAML enforcement", async () => {
    const saml = "Resource protected by organization SAML enforcement.";
    const f = fakeFetch({ [USER]: [200, user], [REPO_X]: [403, { message: saml }] });
    await expect(checkGithub("t", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError(
        `a/x (repos[0]) does not exist or GITHUB_TOKEN cannot see it (GET /repos/a/x returned 403: ${saml})`,
      ),
    );
  });

  it("fails loudly when an accidental pull request has no number to close it by", async () => {
    const f = fakeFetch({ [USER]: [200, user], ...writable, [PULLS_X]: [201, {}] });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        `the pull request check opened a real pull request in a/x, because branch ${HEAD} exists, and could not close it (GitHub's answer had no pull request number): close the pull request from ${HEAD} by hand`,
      ),
    );
  });

  it("fails loudly when an accidental pull request cannot be closed", async () => {
    const f = fakeFetch({
      [USER]: [200, user],
      ...writable,
      [PULLS_X]: [201, { number: 9, html_url: "https://github.com/a/x/pull/9" }],
      "PATCH https://api.github.com/repos/a/x/pulls/9": [403, { message: "Forbidden" }],
    });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        `the pull request check opened a real pull request in a/x, because branch ${HEAD} exists, and could not close it (PATCH returned 403: Forbidden): close https://github.com/a/x/pull/9 by hand`,
      ),
    );
  });

  it("fails loudly when closing an accidental pull request hits a network error", async () => {
    const f = fakeFetch({
      [USER]: [200, user],
      ...writable,
      [PULLS_X]: [201, { number: 9, html_url: "https://github.com/a/x/pull/9" }],
      "PATCH https://api.github.com/repos/a/x/pulls/9": new Error("socket hang up"),
    });
    await expect(checkGithub("t", cfg.repos, f.fetch, { headName })).rejects.toThrow(
      new PreflightError(
        `the pull request check opened a real pull request in a/x, because branch ${HEAD} exists, and could not close it (socket hang up): close https://github.com/a/x/pull/9 by hand`,
      ),
    );
  });

  it("names GITHUB_TOKEN on a status other than 401 and 403", async () => {
    const f = fakeFetch({ [USER]: [500, { message: "boom" }] });
    await expect(checkGithub("t", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError("GitHub rejected GITHUB_TOKEN (GET /user returned 500: boom)"),
    );
  });

  it("names GITHUB_TOKEN when it is empty, without calling GitHub", async () => {
    const f = fakeFetch({});
    await expect(checkGithub("", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError("GITHUB_TOKEN is empty: devbox needs a token that can push to the repos"),
    );
    expect(f.requests).toEqual([]);
  });

  it("skips the push and pull request checks with requirePush false, and still returns the identity", async () => {
    const f = fakeFetch({ [USER]: [200, user], [REPO_X]: [200, repo] });
    expect(await checkGithub("t", cfg.repos.slice(0, 1), f.fetch, { requirePush: false })).toEqual({
      gitName: "Octo Cat",
      gitEmail: "42+octo@users.noreply.github.com",
    });
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([USER, REPO_X]);
  });

  it("asks for a token that can read the repos when push is not required", async () => {
    const f = fakeFetch({});
    await expect(checkGithub("", cfg.repos, f.fetch, { requirePush: false })).rejects.toThrow(
      new PreflightError("GITHUB_TOKEN is empty: devbox needs a token that can read the repos"),
    );
    expect(f.requests).toEqual([]);
  });

  it("names a repo the token cannot see", async () => {
    const f = fakeFetch({ [USER]: [200, user], [REPO_X]: [404, { message: "Not Found" }] });
    await expect(checkGithub("t", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError(
        "a/x (repos[0]) does not exist or GITHUB_TOKEN cannot see it (GET /repos/a/x returned 404: Not Found)",
      ),
    );
  });

  it("reports a network failure", async () => {
    const f = fakeFetch({ [USER]: new Error("getaddrinfo ENOTFOUND api.github.com") });
    await expect(checkGithub("t", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError("GitHub check failed: GET /user: getaddrinfo ENOTFOUND api.github.com"),
    );
  });

  it("reports a network failure on git's push endpoint", async () => {
    const f = fakeFetch({
      [USER]: [200, user],
      [REPO_X]: [200, repo],
      [PUSH_X]: new Error("getaddrinfo ENOTFOUND github.com"),
    });
    await expect(checkGithub("t", cfg.repos, f.fetch)).rejects.toThrow(
      new PreflightError(
        "GitHub check failed: GET https://github.com/a/x.git/info/refs?service=git-receive-pack: getaddrinfo ENOTFOUND github.com",
      ),
    );
  });
});

describe("checkLlm", () => {
  it("sends a tiny Responses API request with reasoning and both auth headers", async () => {
    const f = fakeFetch({ [RESPONSES]: [200, {}] });
    await checkLlm(cfg.llm, "sk-k", f.fetch);
    expect(f.requests).toEqual([
      {
        method: "POST",
        url: "https://api.openai.com/v1/responses",
        headers: {
          "api-key": "sk-k",
          authorization: "Bearer sk-k",
          "content-type": "application/json",
        },
        body: {
          model: "gpt-5.6-sol",
          input: "Reply with OK.",
          max_output_tokens: 16,
          reasoning: { effort: "low", summary: "auto" },
          store: false,
          include: ["reasoning.encrypted_content"],
        },
      },
    ]);
  });

  it("sends no auth headers for an empty key", async () => {
    const f = fakeFetch({ [RESPONSES]: [200, {}] });
    await checkLlm(cfg.llm, "", f.fetch);
    expect(f.requests.map((r) => r.headers)).toEqual([{ "content-type": "application/json" }]);
  });

  it("names the Messages API URL on an anthropic failure, without echoing the key", async () => {
    const f = fakeFetch({
      [MESSAGES]: [
        400,
        { type: "error", error: { type: "invalid_request_error", message: "bad key sk-ant-k" } },
      ],
    });
    await expect(checkLlm(anthropicCfg.llm, "sk-ant-k", f.fetch)).rejects.toThrow(
      new PreflightError(
        'LLM check failed: POST https://api.anthropic.com/v1/messages returned 400 (check llm.baseUrl, llm.model and LLM_API_KEY): {"type":"error","error":{"type":"invalid_request_error","message":"bad key ***"}}',
      ),
    );
  });

  it("sends a tiny Messages API request with thinking, an effort and x-api-key for anthropic", async () => {
    const f = fakeFetch({ [MESSAGES]: [200, {}] });
    await checkLlm(anthropicCfg.llm, "sk-ant-k", f.fetch);
    expect(f.requests).toEqual([
      {
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": "sk-ant-k",
        },
        body: {
          model: "claude-opus-5-5",
          max_tokens: 16,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "low" },
          messages: [{ role: "user", content: "Reply with OK." }],
        },
      },
    ]);
  });

  it("names the base URL and status on failure, without echoing the key", async () => {
    const f = fakeFetch({ [RESPONSES]: [401, { error: { message: "Invalid key sk-k" } }] });
    await expect(checkLlm(cfg.llm, "sk-k", f.fetch)).rejects.toThrow(
      new PreflightError(
        'LLM check failed: POST https://api.openai.com/v1/responses returned 401 (check llm.baseUrl, llm.model and LLM_API_KEY): {"error":{"message":"Invalid key ***"}}',
      ),
    );
  });

  it("an LLM 401 is a CredentialRejected", async () => {
    const cases: Array<[number, boolean]> = [
      [401, true],
      [403, true],
      [404, false],
      [500, false],
    ];
    for (const [status, rejected] of cases) {
      const f = fakeFetch({ [RESPONSES]: [status, { error: "no" }] });
      const err = await checkLlm(cfg.llm, "sk-k", f.fetch).catch((e) => e);
      expect(err).toBeInstanceOf(PreflightError);
      expect(err instanceof CredentialRejected).toBe(rejected);
      expect(err.message).toBe(
        `LLM check failed: POST https://api.openai.com/v1/responses returned ${status} (check llm.baseUrl, llm.model and LLM_API_KEY): {"error":"no"}`,
      );
    }
  });

  it("reports a network failure", async () => {
    const f = fakeFetch({ [RESPONSES]: new Error("connection refused") });
    await expect(checkLlm(cfg.llm, "sk-k", f.fetch)).rejects.toThrow(
      new PreflightError(
        "LLM check failed: POST https://api.openai.com/v1/responses: connection refused",
      ),
    );
  });
});
