import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { Integrations } from "../lib/integrations";
import type { DevboxConfig } from "../up/config";
import type { Fetch } from "../up/preflight";
import { k8sCheck } from "./check";
import { fakeRunner, type Step } from "./fakeRunner";
import type { Target } from "./target";
import type { Values } from "./values";

const kc = (...args: string[]) => ["kubectl", "--context", "kind-devbox", ...args];
const getSecret = (name: string) => kc("get", "secret", name, "-n", "devbox", "-o", "json");
const b64 = (v: string) => Buffer.from(v).toString("base64");

// A Secret that exists, with these decoded keys.
const found = (name: string, data: Record<string, string>): Step => ({
  cmd: getSecret(name),
  result: {
    stdout: JSON.stringify({
      metadata: { name },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])),
    }),
  },
});
const missing = (name: string): Step => ({
  cmd: getSecret(name),
  result: { code: 1, stderr: `Error from server (NotFound): secrets "${name}" not found\n` },
});

const GITHUB_APP = {
  enabled: true,
  appId: 123,
  slug: "example-devbox",
  installationId: 456,
  botUserId: 789,
  tokens: "devbox",
  tokenScope: "repos",
  ciResults: true,
} as const;
const config = (): DevboxConfig => ({
  repos: [
    { url: "https://github.com/acme/widgets.git", branch: "main", owner: "acme", name: "widgets" },
  ],
  llm: { provider: "openai", baseUrl: "https://llm.example.com/v1", model: "m" },
  github: { trustedOrgs: [], trustedUsers: [] },
  integrations: {},
});

const GITHUB_TOKEN = "ghp_PLANTED_TOKEN_1";
const LLM_KEY = "sk-PLANTED_KEY_2";
const LINEAR_SECRET = "lin_PLANTED_SECRET_3";
const WEBHOOK_SECRET = "lin_wh_PLANTED_4";
const SLACK_TOKEN = "xoxb-PLANTED-5";
const GH_WEBHOOK_SECRET = "ghwh_PLANTED_6";
const DATABASE_URL = "postgres://u:PLANTED_PW_7@db.example.com/devbox";
const APP_TOKEN = "ghs_PLANTED_MINTED_8";
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const LINEAR_ON: Integrations = { linear: { enabled: true, clientId: "lin_client" } };

// GitHub, the LLM endpoint and Linear; each accepts only the planted value.
// The GitHub App's calls: `app` is how its coverage and token calls answer.
function fakeFetch(
  opts: {
    github?: number;
    llm?: number;
    linear?: "ok" | "invalid";
    app?: "ok" | "uncovered" | "rejected";
  } = {},
) {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const auth = new Headers(init?.headers).get("Authorization");
    if (opts.app === "rejected" && /^Bearer eyJ/.test(auth ?? "")) {
      return Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 });
    }
    if (url === "https://api.github.com/app") {
      return Response.json({ id: 123, slug: "example-devbox" });
    }
    if (url === "https://api.github.com/repos/acme/widgets/installation") {
      return opts.app === "uncovered"
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json({ id: 456 });
    }
    if (url === "https://api.github.com/app/installations/456") {
      return Response.json({ account: { login: "acme", type: "Organization" } });
    }
    if (url === "https://api.github.com/app/installations/456/access_tokens") {
      return Response.json(
        { token: APP_TOKEN, expires_at: "2026-10-19T13:00:00Z" },
        { status: 201 },
      );
    }
    if (url === "https://api.github.com/user" && auth === `Bearer ${APP_TOKEN}`) {
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    if (url === "https://api.github.com/user") {
      if (opts.github !== undefined || auth !== `Bearer ${GITHUB_TOKEN}`) {
        return Response.json({ message: "Bad credentials" }, { status: opts.github ?? 401 });
      }
      return Response.json({ id: 7, login: "octo", name: "Octo Cat" });
    }
    if (url === "https://api.github.com/repos/acme/widgets") return Response.json({});
    if (url === "https://github.com/acme/widgets.git/info/refs?service=git-receive-pack")
      return new Response("001f# service=git-receive-pack\n");
    if (url === "https://api.github.com/repos/acme/widgets/pulls")
      return Response.json({ message: "Validation Failed" }, { status: 422 });
    if (url === "https://llm.example.com/v1/responses") {
      if (opts.llm !== undefined || auth !== `Bearer ${LLM_KEY}`) {
        return Response.json({ error: "bad key" }, { status: opts.llm ?? 401 });
      }
      return Response.json({});
    }
    if (url === "https://api.linear.app/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      if (opts.linear === "invalid" || body.get("client_secret") !== LINEAR_SECRET) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return Response.json({ access_token: "lin_tok", token_type: "Bearer", expires_in: 2592000 });
    }
    if (url === "https://api.linear.app/graphql") {
      return Response.json({
        data: { viewer: { name: "devbox" }, organization: { name: "Example", urlKey: "example" } },
      });
    }
    return new Response("", { status: 404 });
  };
  return { fetch, calls };
}

async function run(
  script: Step[],
  opts: {
    values?: Values;
    integrations?: Integrations;
    skipPushCheck?: boolean;
    fetch?: ReturnType<typeof fakeFetch>;
  } = {},
) {
  const f = fakeRunner(script);
  const fetch = opts.fetch ?? fakeFetch();
  const logs: string[] = [];
  const target: Target = {
    context: "kind-devbox",
    values: opts.values ?? {},
    ...(opts.integrations ? { integrations: opts.integrations } : {}),
  };
  const code = await k8sCheck(
    {
      cfg: config(),
      target,
      targetPath: "devbox.k8s.json",
      runner: f.runner,
      fetch: fetch.fetch,
      log: (line) => void logs.push(line),
    },
    { skipPushCheck: opts.skipPushCheck === true },
  );
  f.done();
  return { code, logs, fetchCalls: fetch.calls };
}

const HEADER = "Checking Secrets in namespace devbox (context kind-devbox)";
const GITHUB_OK = found("devbox-github", { token: GITHUB_TOKEN });
const LLM_OK = found("devbox-llm", { "api-key": LLM_KEY });
const APP_KEY_OK = found("devbox-github-app", { "private-key": PEM });

describe("k8sCheck", () => {
  it("before install: installer-owned Secrets not created yet are skipped", async () => {
    const r = await run(
      [missing("devbox-github"), missing("devbox-llm"), missing("devbox-integrations")],
      { integrations: LINEAR_ON },
    );
    expect(r.logs).toEqual([
      HEADER,
      "  skip  Secret devbox-github: not created yet (k8s:install creates it)",
      "  skip  Secret devbox-llm: not created yet (k8s:install creates it)",
      "  skip  Secret devbox-integrations: not created yet (k8s:install creates it)",
      '  skip  GitHub token: no usable key "token" in Secret devbox-github',
      '  skip  LLM key: no usable key "api-key" in Secret devbox-llm',
      '  skip  Linear client secret: no usable key "LINEAR_CLIENT_SECRET" in Secret devbox-integrations',
      "  skip  Secret devbox-integrations: LINEAR_CLIENT_SECRET: not created yet (k8s:install creates it)",
      "  skip  Secret devbox-integrations: LINEAR_WEBHOOK_SECRET: not created yet (k8s:install creates it)",
      "All checks passed.",
    ]);
    expect(r.code).toBe(0);
    expect(r.fetchCalls).toEqual([]);
  });

  it("a user's Secret not found fails", async () => {
    const r = await run(
      [missing("my-github"), LLM_OK, missing("my-db"), missing("my-integrations")],
      {
        values: {
          secrets: {
            github: { existingSecret: "my-github" },
            integrations: { existingSecret: "my-integrations" },
          },
          postgresql: { enabled: false },
          database: { existingSecret: "my-db" },
        },
        integrations: { slack: { enabled: true, channelId: "C1" } },
      },
    );
    expect(r.logs).toEqual([
      HEADER,
      "  FAIL  Secret my-github: not found (secrets.github.existingSecret)",
      "  ok    Secret devbox-llm",
      "  FAIL  Secret my-db: not found (database.existingSecret)",
      "  FAIL  Secret my-integrations: not found (secrets.integrations.existingSecret)",
      '  skip  GitHub token: no usable key "token" in Secret my-github',
      "  ok    LLM key",
      "  skip  Secret my-integrations: SLACK_BOT_TOKEN: not found (secrets.integrations.existingSecret)",
      "3 failed.",
    ]);
    expect(r.code).toBe(1);
  });

  it("missing, empty and trailing-newline keys", async () => {
    const r = await run(
      [
        found("devbox-github", { other: "x" }),
        found("devbox-llm", { "api-key": "" }),
        found("my-db", { DATABASE_URL: `${DATABASE_URL}\n` }),
      ],
      { values: { postgresql: { enabled: false }, database: { existingSecret: "my-db" } } },
    );
    expect(r.logs).toEqual([
      HEADER,
      '  FAIL  Secret devbox-github: no key "token"',
      '  FAIL  Secret devbox-llm: key "api-key" is empty',
      // Only the GitHub token and the LLM key go out verbatim (iron-proxy).
      "  ok    Secret my-db",
      '  skip  GitHub token: no usable key "token" in Secret devbox-github',
      '  skip  LLM key: no usable key "api-key" in Secret devbox-llm',
      "2 failed.",
    ]);
    expect(r.code).toBe(1);

    const nl = await run([
      found("devbox-github", { token: `${GITHUB_TOKEN}\n` }),
      found("devbox-llm", { "api-key": `${LLM_KEY}\r\n` }),
    ]);
    expect(nl.logs).toEqual([
      HEADER,
      '  FAIL  Secret devbox-github: key "token" ends with a newline',
      '  FAIL  Secret devbox-llm: key "api-key" ends with a newline',
      '  skip  GitHub token: no usable key "token" in Secret devbox-github',
      '  skip  LLM key: no usable key "api-key" in Secret devbox-llm',
      "2 failed.",
    ]);
    expect(nl.code).toBe(1);
  });

  it("token checks pass and fail", async () => {
    const pass = await run([GITHUB_OK, LLM_OK]);
    expect(pass.logs).toEqual([
      HEADER,
      "  ok    Secret devbox-github",
      "  ok    Secret devbox-llm",
      "  ok    GitHub token",
      "  ok    LLM key",
      "All checks passed.",
    ]);
    expect(pass.code).toBe(0);
    expect(pass.fetchCalls).toEqual([
      "GET https://api.github.com/user",
      "GET https://api.github.com/repos/acme/widgets",
      "GET https://github.com/acme/widgets.git/info/refs?service=git-receive-pack",
      "POST https://api.github.com/repos/acme/widgets/pulls",
      "POST https://llm.example.com/v1/responses",
    ]);

    const fail = await run([GITHUB_OK, LLM_OK], { fetch: fakeFetch({ github: 401, llm: 500 }) });
    expect(fail.logs).toEqual([
      HEADER,
      "  ok    Secret devbox-github",
      "  ok    Secret devbox-llm",
      "  FAIL  GitHub token: GitHub rejected GITHUB_TOKEN (GET /user returned 401: Bad credentials)",
      '  FAIL  LLM key: LLM check failed: POST https://llm.example.com/v1/responses returned 500 (check llm.baseUrl, llm.model and LLM_API_KEY): {"error":"bad key"}',
      "2 failed.",
    ]);
    expect(fail.code).toBe(1);
  });

  it("Linear enabled: client secret checked, keys required", async () => {
    const ok = await run(
      [
        GITHUB_OK,
        LLM_OK,
        found("devbox-integrations", {
          LINEAR_CLIENT_SECRET: LINEAR_SECRET,
          LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
        }),
      ],
      { integrations: LINEAR_ON },
    );
    expect(ok.logs).toEqual([
      HEADER,
      "  ok    Secret devbox-github",
      "  ok    Secret devbox-llm",
      "  ok    Secret devbox-integrations",
      "  ok    GitHub token",
      "  ok    LLM key",
      "  ok    Linear client secret (devbox acts as devbox in workspace Example)",
      "  ok    Secret devbox-integrations: LINEAR_CLIENT_SECRET",
      "  ok    Secret devbox-integrations: LINEAR_WEBHOOK_SECRET",
      "All checks passed.",
    ]);
    expect(ok.code).toBe(0);

    const rejected = await run(
      [
        GITHUB_OK,
        LLM_OK,
        found("devbox-integrations", {
          LINEAR_CLIENT_SECRET: LINEAR_SECRET,
          LINEAR_WEBHOOK_SECRET: "",
        }),
      ],
      { integrations: LINEAR_ON, fetch: fakeFetch({ linear: "invalid" }) },
    );
    expect(rejected.logs).toEqual([
      HEADER,
      "  ok    Secret devbox-github",
      "  ok    Secret devbox-llm",
      "  ok    Secret devbox-integrations",
      "  ok    GitHub token",
      "  ok    LLM key",
      "  FAIL  Linear client secret: Linear rejected the client ID or LINEAR_CLIENT_SECRET (invalid_client): copy them again from the app's page in Linear (Settings → API → Applications)",
      "  ok    Secret devbox-integrations: LINEAR_CLIENT_SECRET",
      '  FAIL  Secret devbox-integrations: LINEAR_WEBHOOK_SECRET: key "LINEAR_WEBHOOK_SECRET" is empty',
      "2 failed.",
    ]);
    expect(rejected.code).toBe(1);

    const noKeys = await run([GITHUB_OK, LLM_OK, found("devbox-integrations", {})], {
      integrations: LINEAR_ON,
    });
    expect(noKeys.logs).toEqual([
      HEADER,
      "  ok    Secret devbox-github",
      "  ok    Secret devbox-llm",
      "  ok    Secret devbox-integrations",
      "  ok    GitHub token",
      "  ok    LLM key",
      '  skip  Linear client secret: no usable key "LINEAR_CLIENT_SECRET" in Secret devbox-integrations',
      '  FAIL  Secret devbox-integrations: LINEAR_CLIENT_SECRET: no key "LINEAR_CLIENT_SECRET"',
      '  FAIL  Secret devbox-integrations: LINEAR_WEBHOOK_SECRET: no key "LINEAR_WEBHOOK_SECRET"',
      "2 failed.",
    ]);
    expect(noKeys.code).toBe(1);
  });

  it("slack and github app webhook keys required when enabled", async () => {
    const r = await run(
      [
        GITHUB_OK,
        APP_KEY_OK,
        LLM_OK,
        found("devbox-integrations", { SLACK_BOT_TOKEN: SLACK_TOKEN }),
      ],
      {
        integrations: {
          linear: { enabled: false },
          slack: { enabled: true, channelId: "C1" },
          githubApp: GITHUB_APP,
        },
      },
    );
    expect(r.logs).toEqual([
      HEADER,
      "  ok    Secret devbox-github",
      "  ok    Secret devbox-github-app",
      "  ok    Secret devbox-llm",
      "  ok    Secret devbox-integrations",
      "  ok    GitHub App token (minted for installation 456)",
      "  ok    GitHub token",
      "  ok    LLM key",
      "  ok    Secret devbox-integrations: SLACK_BOT_TOKEN",
      '  FAIL  Secret devbox-integrations: GITHUB_WEBHOOK_SECRET: no key "GITHUB_WEBHOOK_SECRET"',
      "1 failed.",
    ]);
    expect(r.code).toBe(1);
  });

  it("forbidden stops with the access message", async () => {
    const r = await run([
      GITHUB_OK,
      {
        cmd: getSecret("devbox-llm"),
        result: {
          code: 1,
          stderr:
            'Error from server (Forbidden): secrets "devbox-llm" is forbidden: User "ci" cannot get resource "secrets"\n',
        },
      },
    ]);
    expect(r.logs).toEqual([
      HEADER,
      "  ok    Secret devbox-github",
      "k8s:check needs read access to Secrets in namespace devbox: skip it, or run it with an account that has it",
    ]);
    expect(r.code).toBe(1);
    expect(r.fetchCalls).toEqual([]);
  });

  it("--skip-push-check", async () => {
    const r = await run([GITHUB_OK, LLM_OK], { skipPushCheck: true });
    expect(r.logs).toEqual([
      HEADER,
      "  ok    Secret devbox-github",
      "  ok    Secret devbox-llm",
      "  ok    GitHub token",
      "  ok    LLM key",
      "All checks passed.",
    ]);
    expect(r.fetchCalls).toEqual([
      "GET https://api.github.com/user",
      "GET https://api.github.com/repos/acme/widgets",
      "POST https://llm.example.com/v1/responses",
    ]);
  });

  it("no value ever printed", async () => {
    const planted = [
      GITHUB_TOKEN,
      APP_TOKEN,
      PEM,
      "PRIVATE KEY",
      LLM_KEY,
      LINEAR_SECRET,
      WEBHOOK_SECRET,
      SLACK_TOKEN,
      GH_WEBHOOK_SECRET,
      DATABASE_URL,
      "PLANTED",
    ];
    const all = {
      LINEAR_CLIENT_SECRET: LINEAR_SECRET,
      LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SLACK_BOT_TOKEN: SLACK_TOKEN,
      GITHUB_WEBHOOK_SECRET: GH_WEBHOOK_SECRET,
    };
    const values = { postgresql: { enabled: false }, database: { existingSecret: "my-db" } };
    const integrations: Integrations = {
      ...LINEAR_ON,
      slack: { enabled: true, channelId: "C1" },
      githubApp: GITHUB_APP,
    };
    // Every check passes, then every check fails, then every Secret is broken.
    const runs = [
      await run(
        [
          GITHUB_OK,
          APP_KEY_OK,
          LLM_OK,
          found("my-db", { DATABASE_URL }),
          found("devbox-integrations", all),
        ],
        { values, integrations },
      ),
      await run(
        [
          GITHUB_OK,
          APP_KEY_OK,
          LLM_OK,
          found("my-db", { DATABASE_URL }),
          found("devbox-integrations", all),
        ],
        {
          values,
          integrations,
          fetch: fakeFetch({ app: "rejected", llm: 401, linear: "invalid" }),
        },
      ),
      await run(
        [
          found("devbox-github", { token: `${GITHUB_TOKEN}\n` }),
          found("devbox-github-app", { "private-key": PEM.replace("BEGIN", "BEGAN") }),
          found("devbox-llm", { "api-key": `${LLM_KEY}\n` }),
          found("my-db", { DATABASE_URL: "" }),
          found("devbox-integrations", { ...all, SLACK_BOT_TOKEN: "" }),
        ],
        { values, integrations },
      ),
    ];
    expect(runs.map((r) => r.code)).toEqual([0, 1, 1]);
    for (const line of runs.flatMap((r) => r.logs)) {
      for (const value of planted) expect(line).not.toContain(value);
    }
  });

  describe("GitHub App", () => {
    const APP_ON: Integrations = { githubApp: GITHUB_APP };
    const WEBHOOK_OK = found("devbox-integrations", { GITHUB_WEBHOOK_SECRET: GH_WEBHOOK_SECRET });
    const APP_CALLS = [
      "GET https://api.github.com/app",
      "GET https://api.github.com/repos/acme/widgets/installation",
      "POST https://api.github.com/app/installations/456/access_tokens",
    ];

    it("devbox tokens: the key Secret, a token minted with it, then the token checks", async () => {
      const r = await run([GITHUB_OK, APP_KEY_OK, LLM_OK, WEBHOOK_OK], { integrations: APP_ON });
      expect(r.logs).toEqual([
        HEADER,
        "  ok    Secret devbox-github",
        "  ok    Secret devbox-github-app",
        "  ok    Secret devbox-llm",
        "  ok    Secret devbox-integrations",
        "  ok    GitHub App token (minted for installation 456)",
        "  ok    GitHub token",
        "  ok    LLM key",
        "  ok    Secret devbox-integrations: GITHUB_WEBHOOK_SECRET",
        "All checks passed.",
      ]);
      expect(r.code).toBe(0);
      expect(r.fetchCalls).toEqual([
        ...APP_CALLS,
        "GET https://api.github.com/user",
        "GET https://api.github.com/repos/acme/widgets",
        "GET https://github.com/acme/widgets.git/info/refs?service=git-receive-pack",
        "POST https://api.github.com/repos/acme/widgets/pulls",
        "POST https://llm.example.com/v1/responses",
      ]);
    });

    it("devbox tokens: the user's key Secret is the one read", async () => {
      const r = await run(
        [GITHUB_OK, found("my-app-key", { "private-key": PEM }), LLM_OK, WEBHOOK_OK],
        {
          integrations: APP_ON,
          values: { secrets: { githubApp: { existingSecret: "my-app-key" } } },
          skipPushCheck: true,
        },
      );
      expect(r.logs).toEqual([
        HEADER,
        "  ok    Secret devbox-github",
        "  ok    Secret my-app-key",
        "  ok    Secret devbox-llm",
        "  ok    Secret devbox-integrations",
        "  ok    GitHub App token (minted for installation 456)",
        "  ok    GitHub token",
        "  ok    LLM key",
        "  ok    Secret devbox-integrations: GITHUB_WEBHOOK_SECRET",
        "All checks passed.",
      ]);
    });

    it("devbox tokens: a missing or broken key Secret skips the mint and the token checks", async () => {
      const missingKey = await run([GITHUB_OK, missing("my-app-key"), LLM_OK, WEBHOOK_OK], {
        integrations: APP_ON,
        values: { secrets: { githubApp: { existingSecret: "my-app-key" } } },
      });
      expect(missingKey.logs).toEqual([
        HEADER,
        "  ok    Secret devbox-github",
        "  FAIL  Secret my-app-key: not found (secrets.githubApp.existingSecret)",
        "  ok    Secret devbox-llm",
        "  ok    Secret devbox-integrations",
        '  skip  GitHub App token: no usable key "private-key" in Secret my-app-key',
        "  skip  GitHub token: no GitHub App token to check",
        "  ok    LLM key",
        "  ok    Secret devbox-integrations: GITHUB_WEBHOOK_SECRET",
        "1 failed.",
      ]);
      expect(missingKey.code).toBe(1);

      const notPem = await run(
        [GITHUB_OK, found("devbox-github-app", { "private-key": "not a key" }), LLM_OK, WEBHOOK_OK],
        { integrations: APP_ON },
      );
      expect(notPem.logs).toEqual([
        HEADER,
        "  ok    Secret devbox-github",
        '  FAIL  Secret devbox-github-app: key "private-key" does not hold a PEM private key',
        "  ok    Secret devbox-llm",
        "  ok    Secret devbox-integrations",
        '  skip  GitHub App token: no usable key "private-key" in Secret devbox-github-app',
        "  skip  GitHub token: no GitHub App token to check",
        "  ok    LLM key",
        "  ok    Secret devbox-integrations: GITHUB_WEBHOOK_SECRET",
        "1 failed.",
      ]);
      expect(notPem.fetchCalls).toEqual(["POST https://llm.example.com/v1/responses"]);

      const notYet = await run([GITHUB_OK, missing("devbox-github-app"), LLM_OK, WEBHOOK_OK], {
        integrations: APP_ON,
      });
      expect(notYet.logs).toEqual([
        HEADER,
        "  ok    Secret devbox-github",
        "  skip  Secret devbox-github-app: not created yet (k8s:install creates it)",
        "  ok    Secret devbox-llm",
        "  ok    Secret devbox-integrations",
        '  skip  GitHub App token: no usable key "private-key" in Secret devbox-github-app',
        "  skip  GitHub token: no GitHub App token to check",
        "  ok    LLM key",
        "  ok    Secret devbox-integrations: GITHUB_WEBHOOK_SECRET",
        "All checks passed.",
      ]);
    });

    // The whole output when the mint fails with `why`.
    const mintFailed = (keySecret: string, why: string) => [
      HEADER,
      "  ok    Secret devbox-github",
      `  ok    Secret ${keySecret}`,
      "  ok    Secret devbox-llm",
      "  ok    Secret devbox-integrations",
      `  FAIL  GitHub App token: ${why}`,
      "  skip  GitHub token: no GitHub App token to check",
      "  ok    LLM key",
      "  ok    Secret devbox-integrations: GITHUB_WEBHOOK_SECRET",
      "1 failed.",
    ];
    const REJECTED =
      "GitHub rejected the App's credentials: A JSON web token could not be decoded. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, ";

    it("devbox tokens: a rejected key says how to fix it where it came from", async () => {
      const installers = await run([GITHUB_OK, APP_KEY_OK, LLM_OK, WEBHOOK_OK], {
        integrations: APP_ON,
        fetch: fakeFetch({ app: "rejected" }),
      });
      expect(installers.logs).toEqual(
        mintFailed(
          "devbox-github-app",
          `${REJECTED}fix the saved key (bun run secrets rm GITHUB_APP_PRIVATE_KEY --target devbox.k8s.json, then bun run github:setup --target devbox.k8s.json) and re-run bun run k8s:install --target devbox.k8s.json.`,
        ),
      );
      expect(installers.code).toBe(1);

      const users = await run(
        [GITHUB_OK, found("my-app-key", { "private-key": PEM }), LLM_OK, WEBHOOK_OK],
        {
          integrations: APP_ON,
          values: { secrets: { githubApp: { existingSecret: "my-app-key" } } },
          fetch: fakeFetch({ app: "rejected" }),
        },
      );
      expect(users.logs).toEqual(
        mintFailed(
          "my-app-key",
          `${REJECTED}put the right key in Secret "my-app-key" (key private-key).`,
        ),
      );
      expect(users.code).toBe(1);
    });

    it("devbox tokens: uncovered repos fail the mint", async () => {
      const uncovered = await run([GITHUB_OK, APP_KEY_OK, LLM_OK, WEBHOOK_OK], {
        integrations: APP_ON,
        fetch: fakeFetch({ app: "uncovered" }),
      });
      expect(uncovered.logs).toEqual(
        mintFailed(
          "devbox-github-app",
          'These repos are not in the GitHub App\'s installation: acme/widgets. Add them at https://github.com/organizations/acme/settings/installations/456, or run with tokenScope "installation"',
        ),
      );
      expect(uncovered.code).toBe(1);
    });

    it("external tokens: today's checks on the user's token Secret, no key", async () => {
      const r = await run([found("my-github", { token: GITHUB_TOKEN }), LLM_OK, WEBHOOK_OK], {
        integrations: { githubApp: { ...GITHUB_APP, tokens: "external" } },
        values: { secrets: { github: { existingSecret: "my-github" } } },
      });
      expect(r.logs).toEqual([
        HEADER,
        "  ok    Secret my-github",
        "  ok    Secret devbox-llm",
        "  ok    Secret devbox-integrations",
        "  ok    GitHub token",
        "  ok    LLM key",
        "  ok    Secret devbox-integrations: GITHUB_WEBHOOK_SECRET",
        "All checks passed.",
      ]);
      expect(r.fetchCalls).toEqual([
        "GET https://api.github.com/user",
        "GET https://api.github.com/repos/acme/widgets",
        "GET https://github.com/acme/widgets.git/info/refs?service=git-receive-pack",
        "POST https://api.github.com/repos/acme/widgets/pulls",
        "POST https://llm.example.com/v1/responses",
      ]);
    });
  });
});
