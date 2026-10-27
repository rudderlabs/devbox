import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { enabledGithubApp } from "../lib/integrations";
import {
  composeEnvFor,
  composeProfiles,
  composeStartSteps,
  githubComposeEnv,
  ironProxyTokenOptions,
  linearComposeEnv,
  llmSummary,
} from "../up";
import { parseConfig } from "./config";

const base = {
  PATH: "/usr/bin",
  LINEAR_ENABLED: "true",
  LINEAR_CLIENT_ID: "from-shell",
  LINEAR_CLIENT_SECRET: "from-shell",
  LINEAR_WEBHOOK_SECRET: "from-shell",
};
const raw = {
  repos: [{ url: "https://github.com/example-org/example-repo.git" }],
  llm: { baseUrl: "https://llm.example.com/v1", model: "m1" },
};
const MODEL_ENV_EMPTY = {
  HARNESS_REASONING_EFFORT: "",
  HARNESS_ORIENTATION_MODEL: "",
  HARNESS_ORIENTATION_REASONING_EFFORT: "",
  HARNESS_PLANNING_MODEL: "",
  HARNESS_PLANNING_REASONING_EFFORT: "",
  HARNESS_PLAN_REVIEW_MODEL: "",
  HARNESS_PLAN_REVIEW_REASONING_EFFORT: "",
  HARNESS_IMPLEMENTATION_MODEL: "",
  HARNESS_IMPLEMENTATION_REASONING_EFFORT: "",
  HARNESS_DISTILLATION_MODEL: "",
  HARNESS_DISTILLATION_REASONING_EFFORT: "",
  HARNESS_REVIEW_MODEL: "",
  HARNESS_REVIEW_REASONING_EFFORT: "",
  HARNESS_FOLLOWUP_MODEL: "",
  HARNESS_FOLLOWUP_REASONING_EFFORT: "",
};
const common = {
  PATH: "/usr/bin",
  MAX_CONCURRENT_SANDBOXES: "5",
  SANDBOX_RESOURCE_CPU: "2",
  SANDBOX_RESOURCE_MEMORY: "4Gi",
  GITHUB_TOKEN: "gh",
  LLM_API_KEY: "llm",
  OPENSANDBOX_API_KEY: "osk",
  IRON_PROXY_LLM_HOST: "llm.example.com",
  HARNESS_LLM_BASE_URL: "https://llm.example.com/v1",
  HARNESS_MODEL: "m1",
  HARNESS_LLM_PROVIDER: "openai",
  ...MODEL_ENV_EMPTY,
};

const OFF = {
  LINEAR_ENABLED: "",
  LINEAR_CLIENT_ID: "",
  LINEAR_CLIENT_SECRET: "",
  LINEAR_WEBHOOK_SECRET: "",
};

// The GitHub values in the personal-token mode: all empty, so a value left in
// the shell never reaches Compose.
const GITHUB_OFF = {
  GITHUB_TOKEN_FILE: "",
  GITHUB_TOKEN_DIR: "",
  GITHUB_APP_ID: "",
  GITHUB_APP_INSTALLATION_ID: "",
  GITHUB_APP_REPOSITORIES: "",
  GITHUB_APP_PRIVATE_KEY: "",
  GITHUB_WEBHOOKS_ENABLED: "",
  GITHUB_WEBHOOK_SECRET: "",
  GITHUB_BOT_LOGIN: "",
  GITHUB_BOT_USER_ID: "",
  GITHUB_CI_RESULT_ENABLED: "",
  GITHUB_TRUSTED_ORGS: "",
  GITHUB_TRUSTED_USERS: "",
};

describe("linearComposeEnv", () => {
  it("four empty when not configured", () => {
    expect(linearComposeEnv(undefined)).toEqual(OFF);
    // Secrets resolved by mistake still never turn Linear on.
    expect(linearComposeEnv(undefined, { clientSecret: "cs", webhookSecret: "ws" })).toEqual(OFF);
  });

  it("four empty when enabled is false, even with secrets in the shell", () => {
    const linear = { enabled: false, clientId: "client-1" };
    expect(linearComposeEnv(linear)).toEqual(OFF);
    expect(linearComposeEnv(linear, { clientSecret: "cs", webhookSecret: "ws" })).toEqual(OFF);
    const cfg = parseConfig({ ...raw, integrations: { linear } });
    expect(composeEnvFor(base, cfg, { github: "gh", llm: "llm", opensandboxKey: "osk" })).toEqual({
      ...common,
      ...OFF,
      ...GITHUB_OFF,
    });
  });

  it("LINEAR_ENABLED true and the three values when enabled", () => {
    expect(
      linearComposeEnv(
        { enabled: true, clientId: "client-1" },
        { clientSecret: "cs", webhookSecret: "ws" },
      ),
    ).toEqual({
      LINEAR_ENABLED: "true",
      LINEAR_CLIENT_ID: "client-1",
      LINEAR_CLIENT_SECRET: "cs",
      LINEAR_WEBHOOK_SECRET: "ws",
    });
  });

  it("refuses an enabled Linear without its secrets", () => {
    expect(() => linearComposeEnv({ enabled: true, clientId: "client-1" })).toThrow(
      "integrations.linear is enabled but the Linear secrets were not resolved",
    );
  });
});

describe("llmSummary", () => {
  it("is unchanged without effort or stage settings", () => {
    expect(llmSummary(parseConfig(raw).llm)).toBe(
      "provider openai, model m1 at https://llm.example.com/v1",
    );
  });

  it("shows the global effort and each stage override with its value", () => {
    const cfg = parseConfig({
      ...raw,
      llm: {
        ...raw.llm,
        reasoningEffort: "high",
        stages: {
          review: { model: "gpt-pro", reasoningEffort: "xhigh" },
          orientation: { reasoningEffort: "minimal" },
        },
      },
    });
    expect(llmSummary(cfg.llm)).toBe(
      "provider openai, model m1 at https://llm.example.com/v1, reasoning high, stage overrides: review.model=gpt-pro, review.reasoningEffort=xhigh, orientation.reasoningEffort=minimal",
    );
  });
});

describe("composeEnvFor", () => {
  it("a LINEAR_* left in the shell never turns Linear on", () => {
    expect(
      composeEnvFor(base, parseConfig(raw), { github: "gh", llm: "llm", opensandboxKey: "osk" }),
    ).toEqual({
      ...common,
      ...OFF,
      ...GITHUB_OFF,
    });
  });

  it("passes the configured Linear values over the shell's", () => {
    const cfg = parseConfig({
      ...raw,
      integrations: { linear: { enabled: true, clientId: "client-1" } },
    });
    expect(
      composeEnvFor(base, cfg, {
        github: "gh",
        llm: "llm",
        opensandboxKey: "osk",
        linear: { clientSecret: "cs", webhookSecret: "ws" },
      }),
    ).toEqual({
      ...common,
      LINEAR_ENABLED: "true",
      LINEAR_CLIENT_ID: "client-1",
      LINEAR_CLIENT_SECRET: "cs",
      LINEAR_WEBHOOK_SECRET: "ws",
      ...GITHUB_OFF,
    });
  });

  it("passes configured sandbox values over the shell's", () => {
    const shell = {
      ...base,
      MAX_CONCURRENT_SANDBOXES: "99",
      SANDBOX_RESOURCE_CPU: "99",
      SANDBOX_RESOURCE_MEMORY: "99Gi",
    };
    const cfg = parseConfig({
      ...raw,
      sandbox: { maxConcurrent: 3, cpu: "500m", memory: "512Mi" },
    });
    expect(composeEnvFor(shell, cfg, { github: "gh", llm: "llm", opensandboxKey: "osk" })).toEqual({
      ...common,
      MAX_CONCURRENT_SANDBOXES: "3",
      SANDBOX_RESOURCE_CPU: "500m",
      SANDBOX_RESOURCE_MEMORY: "512Mi",
      ...OFF,
      ...GITHUB_OFF,
    });
  });

  it("sets all model variables and does not leak shell values", () => {
    const shell = {
      ...base,
      HARNESS_REASONING_EFFORT: "from-shell",
      HARNESS_FOLLOWUP_MODEL: "from-shell",
      HARNESS_REVIEW_REASONING_EFFORT: "from-shell",
    };
    const cfg = parseConfig({
      ...raw,
      llm: {
        ...raw.llm,
        reasoningEffort: "high",
        stages: {
          review: { model: " reviewer ", reasoningEffort: "xhigh" },
          orientation: { reasoningEffort: "minimal" },
        },
      },
    });
    const env = composeEnvFor(shell, cfg, { github: "gh", llm: "llm", opensandboxKey: "osk" });
    expect(env).toMatchObject({
      HARNESS_REASONING_EFFORT: "high",
      HARNESS_REVIEW_MODEL: "reviewer",
      HARNESS_REVIEW_REASONING_EFFORT: "xhigh",
      HARNESS_ORIENTATION_REASONING_EFFORT: "minimal",
      HARNESS_FOLLOWUP_MODEL: "",
    });
    expect(
      Object.keys(env).filter((name) => /^HARNESS_(?:REASONING|.*_(?:MODEL|REASONING))/.test(name)),
    ).toHaveLength(15);
  });

  it("an empty GitHub token gets the placeholder", () => {
    expect(
      composeEnvFor({}, parseConfig(raw), { github: "", llm: "", opensandboxKey: "osk" }),
    ).toEqual({
      MAX_CONCURRENT_SANDBOXES: "5",
      SANDBOX_RESOURCE_CPU: "2",
      SANDBOX_RESOURCE_MEMORY: "4Gi",
      OPENSANDBOX_API_KEY: "osk",
      IRON_PROXY_LLM_HOST: "llm.example.com",
      HARNESS_LLM_BASE_URL: "https://llm.example.com/v1",
      HARNESS_MODEL: "m1",
      HARNESS_LLM_PROVIDER: "openai",
      ...MODEL_ENV_EMPTY,
      GITHUB_TOKEN: "no-github-token",
      LLM_API_KEY: "",
      ...OFF,
      ...GITHUB_OFF,
    });
  });
});

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END RSA PRIVATE KEY-----\n";
const appRaw = {
  enabled: true,
  appId: 123,
  slug: "example-devbox",
  installationId: 456,
  botUserId: 789,
  tokens: "devbox",
};
const twoRepos = [
  { url: "https://github.com/example-org/example-repo.git" },
  { url: "https://github.com/example-org/other-repo.git" },
];
const trust = { trustedOrgs: ["example-org"], trustedUsers: ["alice", "bob"] };
const withApp = (githubApp: Record<string, unknown>) =>
  parseConfig({ ...raw, repos: twoRepos, github: trust, integrations: { githubApp } });

// The webhook values both App modes pass.
const WEBHOOKS = {
  GITHUB_WEBHOOKS_ENABLED: "true",
  GITHUB_WEBHOOK_SECRET: "whs",
  GITHUB_BOT_LOGIN: "example-devbox",
  GITHUB_BOT_USER_ID: "789",
  GITHUB_CI_RESULT_ENABLED: "true",
  GITHUB_TRUSTED_ORGS: "example-org",
  GITHUB_TRUSTED_USERS: "alice,bob",
};

describe("githubComposeEnv", () => {
  it("personal token: everything empty, no profile", () => {
    const cfg = parseConfig(raw);
    expect(githubComposeEnv(undefined, cfg, {})).toEqual(GITHUB_OFF);
    expect(composeProfiles(undefined)).toEqual([]);
  });

  it("personal token: the trust lists still pass when set", () => {
    const cfg = parseConfig({ ...raw, github: trust });
    expect(githubComposeEnv(undefined, cfg, {})).toEqual({
      ...GITHUB_OFF,
      GITHUB_TRUSTED_ORGS: "example-org",
      GITHUB_TRUSTED_USERS: "alice,bob",
    });
  });

  it("devbox-minted: the minter's settings, the token file, webhooks and the profile", () => {
    const cfg = withApp(appRaw);
    const app = enabledGithubApp(cfg.integrations);
    expect(githubComposeEnv(app, cfg, { webhookSecret: "whs", pem: PEM })).toEqual({
      ...WEBHOOKS,
      GITHUB_TOKEN: "",
      GITHUB_TOKEN_FILE: "/var/run/devbox/github/token",
      GITHUB_TOKEN_DIR: "",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_REPOSITORIES: "example-repo,other-repo",
      GITHUB_APP_PRIVATE_KEY: PEM,
    });
    expect(composeProfiles(app)).toEqual(["github-app"]);
  });

  it("devbox-minted with tokenScope installation: no narrowing; ciResults off", () => {
    const cfg = withApp({ ...appRaw, tokenScope: "installation", ciResults: false });
    const app = enabledGithubApp(cfg.integrations);
    expect(githubComposeEnv(app, cfg, { webhookSecret: "whs", pem: PEM })).toEqual({
      ...WEBHOOKS,
      GITHUB_CI_RESULT_ENABLED: "false",
      GITHUB_TOKEN: "",
      GITHUB_TOKEN_FILE: "/var/run/devbox/github/token",
      GITHUB_TOKEN_DIR: "",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_REPOSITORIES: "",
      GITHUB_APP_PRIVATE_KEY: PEM,
    });
  });

  it("external: the token file's directory is mounted, no key, no profile", () => {
    const cfg = withApp({ ...appRaw, tokens: "external", tokenFile: "/srv/gh/app-token" });
    const app = enabledGithubApp(cfg.integrations);
    expect(githubComposeEnv(app, cfg, { webhookSecret: "whs" })).toEqual({
      ...WEBHOOKS,
      GITHUB_TOKEN: "",
      GITHUB_TOKEN_FILE: "/var/run/devbox/github/app-token",
      GITHUB_TOKEN_DIR: "/srv/gh",
      GITHUB_APP_ID: "",
      GITHUB_APP_INSTALLATION_ID: "",
      GITHUB_APP_REPOSITORIES: "",
      GITHUB_APP_PRIVATE_KEY: "",
    });
    expect(composeProfiles(app)).toEqual([]);
  });

  it("refuses an App without its resolved secrets", () => {
    const cfg = withApp(appRaw);
    const app = enabledGithubApp(cfg.integrations);
    expect(() => githubComposeEnv(app, cfg, { pem: PEM })).toThrow(
      "integrations.githubApp is enabled but GITHUB_WEBHOOK_SECRET was not resolved",
    );
    expect(() => githubComposeEnv(app, cfg, { webhookSecret: "whs" })).toThrow(
      "integrations.githubApp is enabled but the GitHub App's private key was not resolved",
    );
  });

  it("composeEnvFor: in an App mode a GITHUB_* left in the shell never leaks through", () => {
    const cfg = withApp(appRaw);
    const shell = {
      PATH: "/usr/bin",
      GITHUB_TOKEN: "from-shell",
      GITHUB_TOKEN_FILE: "/from/shell",
      GITHUB_TOKEN_DIR: "/from/shell",
      GITHUB_TRUSTED_ORGS: "shell-org",
    };
    expect(
      composeEnvFor(shell, cfg, {
        github: "",
        llm: "llm",
        opensandboxKey: "osk",
        githubApp: { webhookSecret: "whs", pem: PEM },
      }),
    ).toEqual({
      ...common,
      ...OFF,
      ...WEBHOOKS,
      GITHUB_TOKEN: "",
      GITHUB_TOKEN_FILE: "/var/run/devbox/github/token",
      GITHUB_TOKEN_DIR: "",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_REPOSITORIES: "example-repo,other-repo",
      GITHUB_APP_PRIVATE_KEY: PEM,
    });
  });
});

describe("composeStartSteps", () => {
  const base = ["docker", "compose", "-f", "/devbox/control-plane/docker-compose.yml"];
  const appOf = (githubApp: Record<string, unknown>) => {
    const app = enabledGithubApp(withApp(githubApp).integrations);
    if (!app) throw new Error("the App is not enabled");
    return app;
  };

  it("devbox-minted: starts with the profile and recreates the minter and iron-proxy", () => {
    expect(composeStartSteps(appOf(appRaw), base)).toEqual([
      {
        cmd: [
          ...base,
          "--profile",
          "github-app",
          "run",
          "--rm",
          "--build",
          "github-token",
          "bun",
          "run",
          "github-token",
          "--once",
        ],
      },
      { cmd: [...base, "--profile", "github-app", "up", "-d", "--build"] },
      {
        cmd: [
          ...base,
          "--profile",
          "github-app",
          "up",
          "-d",
          "--force-recreate",
          "--no-deps",
          "github-token",
        ],
      },
      {
        cmd: [
          ...base,
          "--profile",
          "github-app",
          "up",
          "-d",
          "--force-recreate",
          "--no-deps",
          "iron-proxy",
        ],
      },
    ]);
  });

  const unprofiledSteps = [
    {
      cmd: [...base, "--profile", "github-app", "rm", "-sf", "github-token"],
      ignore: /no such (service|container)/i,
    },
    { cmd: [...base, "up", "-d", "--build"] },
    { cmd: [...base, "up", "-d", "--force-recreate", "--no-deps", "iron-proxy"] },
  ];

  it("personal token: removes a stale minter and recreates iron-proxy", () => {
    expect(composeStartSteps(undefined, base)).toEqual(unprofiledSteps);
  });

  it("external App token: starts without the profile and recreates iron-proxy", () => {
    expect(
      composeStartSteps(appOf({ ...appRaw, tokens: "external", tokenFile: "/srv/gh/t" }), base),
    ).toEqual(unprofiledSteps);
  });
});

describe("ironProxyTokenOptions", () => {
  it("env for the personal token, the token file in both App modes", () => {
    expect(ironProxyTokenOptions(undefined)).toEqual({ githubTokenSource: "env" });
    const devbox = enabledGithubApp(withApp(appRaw).integrations);
    expect(ironProxyTokenOptions(devbox)).toEqual({
      githubTokenSource: "file",
      githubTokenFile: "/var/run/devbox/github/token",
    });
    const external = enabledGithubApp(
      withApp({ ...appRaw, tokens: "external", tokenFile: "/srv/gh/app-token" }).integrations,
    );
    expect(ironProxyTokenOptions(external)).toEqual({
      githubTokenSource: "file",
      githubTokenFile: "/var/run/devbox/github/app-token",
    });
  });
});

describe("docker-compose.yml", () => {
  type Service = {
    image?: string;
    build?: unknown;
    volumes: string[];
    environment: Record<string, string>;
    [key: string]: unknown;
  };
  const doc = parse(
    readFileSync(join(import.meta.dir, "..", "..", "docker-compose.yml"), "utf8"),
  ) as { services: Record<string, Service>; secrets: unknown; volumes: Record<string, unknown> };
  const service = (name: string): Service => {
    const found = doc.services[name];
    if (!found) throw new Error(`docker-compose.yml has no ${name} service`);
    return found;
  };
  // Compose's own interpolation, written as it appears in the file.
  const empty = (name: string) => `\${${name}:-}`;
  const TOKEN_MOUNT = `\${GITHUB_TOKEN_DIR:-devbox_github_token}:/var/run/devbox/github:ro`;

  it("runs the token minter from the control plane's image, in the github-app profile", () => {
    const cp = service("control-plane");
    expect(service("github-token")).toEqual({
      profiles: ["github-app"],
      image: cp.image,
      build: cp.build,
      restart: "unless-stopped",
      command: ["bun", "run", "github-token"],
      environment: {
        GITHUB_APP_ID: empty("GITHUB_APP_ID"),
        GITHUB_APP_INSTALLATION_ID: empty("GITHUB_APP_INSTALLATION_ID"),
        GITHUB_APP_REPOSITORIES: empty("GITHUB_APP_REPOSITORIES"),
        GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/github_app_private_key",
        GITHUB_TOKEN_SINK: "file:/var/run/devbox/github/token",
      },
      secrets: ["github_app_private_key"],
      volumes: [
        ".:/app",
        "node_modules:/app/node_modules",
        "devbox_github_token:/var/run/devbox/github",
      ],
      networks: ["default"],
    });
    expect(cp.image).toBe("devbox-control-plane");
    expect(cp.build).toEqual({ context: ".", dockerfile: "Dockerfile.dev" });
    expect(cp.volumes).toEqual(
      expect.arrayContaining([".:/app", "node_modules:/app/node_modules"]),
    );
  });

  it("takes the private key as a Compose secret from GITHUB_APP_PRIVATE_KEY", () => {
    expect(doc.secrets).toEqual({
      github_app_private_key: { environment: "GITHUB_APP_PRIVATE_KEY" },
    });
    expect(doc.volumes.devbox_github_token).toEqual({ name: "devbox_github_token" });
  });

  it("mounts the token directory read-only in the control plane and iron-proxy", () => {
    expect(service("control-plane").volumes).toContain(TOKEN_MOUNT);
    expect(service("iron-proxy").volumes).toContain(TOKEN_MOUNT);
  });

  it("defaults the control plane's sandbox settings for bare Compose", () => {
    expect(service("control-plane").environment).toMatchObject({
      MAX_CONCURRENT_SANDBOXES: `\${MAX_CONCURRENT_SANDBOXES:-5}`,
      SANDBOX_RESOURCE_CPU: `\${SANDBOX_RESOURCE_CPU:-2}`,
      SANDBOX_RESOURCE_MEMORY: `\${SANDBOX_RESOURCE_MEMORY:-4Gi}`,
    });
  });

  it("lists all model overrides with empty defaults", () => {
    const env = service("control-plane").environment;
    for (const name of Object.keys(MODEL_ENV_EMPTY)) expect(env[name]).toBe(empty(name));
  });

  it("lists the control plane's GitHub settings with empty defaults", () => {
    const env = service("control-plane").environment;
    for (const name of [
      "GITHUB_TOKEN",
      "GITHUB_TOKEN_FILE",
      "GITHUB_WEBHOOKS_ENABLED",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_BOT_LOGIN",
      "GITHUB_BOT_USER_ID",
      "GITHUB_CI_RESULT_ENABLED",
      "GITHUB_TRUSTED_ORGS",
      "GITHUB_TRUSTED_USERS",
    ]) {
      expect(env[name]).toBe(empty(name));
    }
  });
});
