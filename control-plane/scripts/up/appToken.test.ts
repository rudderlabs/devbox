import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAppSetupError } from "../lib/githubApp";
import { PrivateKeyError } from "../lib/githubAppKey";
import { enabledGithubApp } from "../lib/integrations";
import { MemoryKeychain } from "../lib/keychain";
import type { ResolverDeps } from "../lib/secrets";
import { appToken } from "../up";
import { parseConfig } from "./config";

const { privateKey: pem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const dir = mkdtempSync(join(tmpdir(), "devbox-app-token-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const API = "https://api.github.com";
const appRaw = {
  enabled: true,
  appId: 123,
  slug: "example-devbox",
  installationId: 456,
  botUserId: 789,
  tokens: "devbox",
};
const configWith = (githubApp: Record<string, unknown>) =>
  parseConfig({
    repos: [{ url: "https://github.com/example-org/example-repo.git" }],
    llm: { baseUrl: "https://llm.example.com/v1", model: "m1" },
    github: { trustedOrgs: ["example-org"] },
    integrations: { githubApp },
  });

const GET_APP = `GET ${API}/app`;
const APP_OK: [number, unknown] = [200, { id: 123, slug: "example-devbox" }];
const COVERAGE = `GET ${API}/repos/example-org/example-repo/installation`;
const MINT = `POST ${API}/app/installations/456/access_tokens`;
const INSTALLATION = `GET ${API}/app/installations/456`;
// checkGithub's calls for one repo, all passing for an App token.
const CHECKS = {
  [`GET ${API}/user`]: [403, { message: "Resource not accessible by integration" }],
  [`GET ${API}/repos/example-org/example-repo`]: [200, {}],
  "GET https://github.com/example-org/example-repo.git/info/refs?service=git-receive-pack": [
    200,
    "",
  ],
  [`POST ${API}/repos/example-org/example-repo/pulls`]: [422, { message: "Validation Failed" }],
} satisfies Record<string, [number, unknown]>;
const minted = { token: "ghs_minted", expires_at: "2026-10-19T13:00:00Z" };

function fakeFetch(routes: Record<string, [number, unknown]>) {
  const requests: { call: string; body?: unknown }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const call = `${init?.method ?? "GET"} ${url}`;
    requests.push({ call, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const route = routes[call];
    if (!route) return new Response("not routed", { status: 599 });
    return Response.json(route[1], { status: route[0] });
  };
  return { fetch, requests, calls: () => requests.map((r) => r.call) };
}

function deps(entries: Record<string, string> = {}) {
  const keychain = new MemoryKeychain(entries);
  const log: string[] = [];
  const prompts: string[] = [];
  const d: ResolverDeps = {
    env: {},
    keychain,
    deployment: { kind: "compose" },
    isTTY: true,
    prompt: async (q) => {
      prompts.push(q);
      return "";
    },
    confirm: async () => false,
    run: async () => ({ code: 1, stdout: "" }),
    log: (l) => void log.push(l),
  };
  return { d, keychain, log, prompts };
}

describe("appToken, devbox-minted", () => {
  const cfg = configWith(appRaw);
  const app = enabledGithubApp(cfg.integrations);
  if (!app) throw new Error("the App is not enabled");

  it("checks coverage, mints a token narrowed to the repos, then runs the repo checks", async () => {
    const f = fakeFetch({
      [GET_APP]: APP_OK,
      [COVERAGE]: [200, { id: 456 }],
      [MINT]: [201, minted],
      ...CHECKS,
    });
    const s = deps();
    const token = await appToken(app, cfg, { pem, source: "env" }, s.d, {
      skipChecks: false,
      fetch: f.fetch,
    });
    expect(token).toBe("ghs_minted");
    expect(f.calls()).toEqual([GET_APP, COVERAGE, MINT, ...Object.keys(CHECKS)]);
    expect(f.requests[2]?.body).toEqual({ repositories: ["example-repo"] });
    expect(s.log).toEqual(["GitHub App example-devbox: minted a token for installation 456"]);
  });

  it("refuses repos outside the installation before minting, naming where to add them", async () => {
    const f = fakeFetch({
      [GET_APP]: APP_OK,
      [COVERAGE]: [404, { message: "Not Found" }],
      [INSTALLATION]: [200, { account: { login: "example-org", type: "Organization" } }],
    });
    await expect(
      appToken(app, cfg, { pem, source: "env" }, deps().d, { skipChecks: false, fetch: f.fetch }),
    ).rejects.toThrow(
      'These repos are not in the GitHub App\'s installation: example-org/example-repo. Add them at https://github.com/organizations/example-org/settings/installations/456, or run with tokenScope "installation"',
    );
    expect(f.calls()).toEqual([GET_APP, COVERAGE, INSTALLATION]);
  });

  const REJECTED = new PrivateKeyError(
    "GitHub rejected the App's credentials: A JSON web token could not be decoded. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, run bun run secrets rm GITHUB_APP_PRIVATE_KEY, then bun run github:setup.",
  );

  it("a key GitHub rejects stops the run; the saved key is kept and nothing is prompted", async () => {
    const f = fakeFetch({
      [GET_APP]: [401, { message: "A JSON web token could not be decoded" }],
    });
    const s = deps({ "compose/GITHUB_APP_PRIVATE_KEY": pem });
    const err = await appToken(app, cfg, { pem, source: "keychain" }, s.d, {
      skipChecks: false,
      fetch: f.fetch,
    }).catch((e) => e);
    expect(err).toEqual(REJECTED);
    expect(s.keychain.entries()).toEqual({ "compose/GITHUB_APP_PRIVATE_KEY": pem });
    expect(s.prompts).toEqual([]);
    expect(f.calls()).toEqual([GET_APP]);
  });

  it("a key rejected while minting (checks skipped) stops the run the same way", async () => {
    const f = fakeFetch({
      [GET_APP]: APP_OK,
      [MINT]: [401, { message: "A JSON web token could not be decoded" }],
    });
    const s = deps({ "compose/GITHUB_APP_PRIVATE_KEY": pem });
    const err = await appToken(app, cfg, { pem, source: "keychain" }, s.d, {
      skipChecks: true,
      fetch: f.fetch,
    }).catch((e) => e);
    expect(err).toEqual(REJECTED);
    expect(s.keychain.entries()).toEqual({ "compose/GITHUB_APP_PRIVATE_KEY": pem });
    expect(s.prompts).toEqual([]);
  });

  it("with --skip-checks only mints; tokenScope installation does not narrow", async () => {
    const wide = configWith({ ...appRaw, tokenScope: "installation" });
    const wideApp = enabledGithubApp(wide.integrations);
    if (!wideApp) throw new Error("the App is not enabled");
    const f = fakeFetch({ [GET_APP]: APP_OK, [MINT]: [201, minted] });
    expect(
      await appToken(wideApp, wide, { pem, source: "env" }, deps().d, {
        skipChecks: true,
        fetch: f.fetch,
      }),
    ).toBe("ghs_minted");
    expect(f.requests).toEqual([{ call: GET_APP }, { call: MINT, body: {} }]);
  });

  it("a wrong App id stops before the coverage check, naming the setting", async () => {
    const f = fakeFetch({ [GET_APP]: [404, { message: "Integration not found" }] });
    const s = deps({ "compose/GITHUB_APP_PRIVATE_KEY": pem });
    const err = await appToken(app, cfg, { pem, source: "keychain" }, s.d, {
      skipChecks: false,
      fetch: f.fetch,
    }).catch((e) => e);
    expect(err).toEqual(
      new GithubAppSetupError(
        "GitHub has no App with id 123: check integrations.githubApp.appId (the App's settings page shows its App ID)",
      ),
    );
    expect(f.calls()).toEqual([GET_APP]);
    expect(s.keychain.entries()).toEqual({ "compose/GITHUB_APP_PRIVATE_KEY": pem });
    expect(s.prompts).toEqual([]);
  });

  it("names the call when GitHub refuses a mint for another reason", async () => {
    const f = fakeFetch({ [GET_APP]: APP_OK, [MINT]: [404, { message: "Not Found" }] });
    await expect(
      appToken(app, cfg, { pem, source: "env" }, deps().d, { skipChecks: true, fetch: f.fetch }),
    ).rejects.toThrow(
      "minting a GitHub App token failed: GitHub POST /app/installations/456/access_tokens: HTTP 404: Not Found",
    );
  });
});

describe("appToken, external", () => {
  it("reads the token file once and runs the repo checks with it", async () => {
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "ghs_external\n");
    const cfg = configWith({ ...appRaw, tokens: "external", tokenFile });
    const app = enabledGithubApp(cfg.integrations);
    if (!app) throw new Error("the App is not enabled");
    const f = fakeFetch(CHECKS);
    const s = deps();
    expect(await appToken(app, cfg, undefined, s.d, { skipChecks: false, fetch: f.fetch })).toBe(
      "ghs_external",
    );
    expect(f.calls()).toEqual(Object.keys(CHECKS));
    expect(s.log).toEqual([`GitHub App example-devbox: token from ${tokenFile}`]);
  });

  it("fails naming the setting when the file is missing", async () => {
    const tokenFile = join(dir, "missing");
    const cfg = configWith({ ...appRaw, tokens: "external", tokenFile });
    const app = enabledGithubApp(cfg.integrations);
    if (!app) throw new Error("the App is not enabled");
    await expect(
      appToken(app, cfg, undefined, deps().d, { skipChecks: false, fetch: fakeFetch({}).fetch }),
    ).rejects.toThrow(`integrations.githubApp.tokenFile ${tokenFile}: not found`);
  });
});
