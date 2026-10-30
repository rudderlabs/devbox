import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { enabledGithubApp, enabledLinear, parseIntegrations } from "./integrations";

class Failed extends Error {}
const fail = (msg: string): never => {
  throw new Failed(msg);
};
const K8S = { platform: "k8s" } as const;
const COMPOSE = { platform: "compose" } as const;

function failure(raw: unknown, opts: { platform: "compose" | "k8s" } = K8S): string {
  try {
    parseIntegrations(raw, fail, opts);
  } catch (err) {
    if (err instanceof Failed) return err.message;
    throw err;
  }
  throw new Error("expected a failure");
}

describe("parseIntegrations", () => {
  it("accepts enabled and clientId", () => {
    expect(
      parseIntegrations({ linear: { enabled: true, clientId: " abc123 " } }, fail, COMPOSE),
    ).toEqual({ linear: { enabled: true, clientId: "abc123" } });
  });

  it("refuses integrations.linear.publicUrl: it moved to the top level", () => {
    expect(
      failure({ linear: { enabled: true, clientId: "a", publicUrl: "https://x.example.com" } }),
    ).toBe(
      'integrations.linear: unknown key "publicUrl" (allowed: enabled, clientId); moved to the top-level publicUrl',
    );
  });

  it("is empty when absent", () => {
    expect(parseIntegrations(undefined, fail, COMPOSE)).toEqual({});
    expect(parseIntegrations({}, fail, K8S)).toEqual({});
  });

  it("enabled is required", () => {
    for (const name of ["linear", "slack", "githubApp"]) {
      expect(failure({ [name]: {} })).toBe(`integrations.${name}.enabled: required, true or false`);
      expect(failure({ [name]: { enabled: "true" } })).toBe(
        `integrations.${name}.enabled: required, true or false`,
      );
    }
  });

  it("enabled false keeps the other keys", () => {
    expect(
      parseIntegrations(
        {
          linear: { enabled: false, clientId: "abc123" },
          slack: { enabled: false, channelId: "C123" },
          githubApp: { enabled: false, slug: "example-devbox", botUserId: 42 },
        },
        fail,
        K8S,
      ),
    ).toEqual({
      linear: { enabled: false, clientId: "abc123" },
      slack: { enabled: false, channelId: "C123" },
      githubApp: {
        enabled: false,
        slug: "example-devbox",
        botUserId: 42,
        tokenScope: "repos",
        ciResults: true,
      },
    });
    // Off needs no settings, but present ones are still checked.
    expect(parseIntegrations({ linear: { enabled: false } }, fail, COMPOSE)).toEqual({
      linear: { enabled: false },
    });
    expect(failure({ linear: { enabled: false, clientId: " " } })).toBe(
      "integrations.linear.clientId: must be a non-empty string",
    );
  });

  it("clientId required when enabled", () => {
    expect(failure({ linear: { enabled: true } })).toBe(
      "integrations.linear.clientId: required when enabled is true",
    );
    expect(failure({ linear: { enabled: true, clientId: "  " } })).toBe(
      "integrations.linear.clientId: must be a non-empty string",
    );
    expect(failure({ linear: { enabled: true, clientId: 7 } })).toBe(
      "integrations.linear.clientId: must be a non-empty string",
    );
  });

  it("slack parsed on k8s", () => {
    expect(parseIntegrations({ slack: { enabled: true, channelId: " C123 " } }, fail, K8S)).toEqual(
      { slack: { enabled: true, channelId: "C123" } },
    );
    expect(failure({ slack: { enabled: true } })).toBe(
      "integrations.slack.channelId: required when enabled is true",
    );
  });

  it("slack notifySources: a non-empty list of task sources", () => {
    expect(
      parseIntegrations(
        { slack: { enabled: true, channelId: "C1", notifySources: ["linear", "api"] } },
        fail,
        K8S,
      ),
    ).toEqual({ slack: { enabled: true, channelId: "C1", notifySources: ["linear", "api"] } });
    for (const notifySources of [[], ["github"], "linear"]) {
      expect(failure({ slack: { enabled: true, channelId: "C1", notifySources } })).toBe(
        "integrations.slack.notifySources: must be a non-empty list of: linear, api",
      );
    }
  });

  it("slack refused on Compose", () => {
    expect(failure({ slack: { enabled: true, channelId: "C123" } }, COMPOSE)).toBe(
      "integrations.slack: supported on Kubernetes only (the target file)",
    );
  });

  it("a leftover githubWebhooks is refused on both platforms", () => {
    const msg =
      "integrations.githubWebhooks: replaced by integrations.githubApp; run bun run github:setup";
    expect(failure({ githubWebhooks: { enabled: false } }, COMPOSE)).toBe(msg);
    expect(failure({ githubWebhooks: { enabled: true, botLogin: "b", botUserId: 1 } })).toBe(msg);
  });

  it("refuses a non-object", () => {
    expect(failure("linear")).toBe("integrations: must be an object");
    expect(failure({ linear: [] })).toBe("integrations.linear: must be an object");
    expect(failure({ slack: "on" })).toBe("integrations.slack: must be an object");
  });

  it("refuses an unknown key in integrations", () => {
    expect(failure({ jira: {} })).toBe(
      'integrations: unknown key "jira" (allowed: linear, slack, githubApp)',
    );
    expect(failure({ jira: {} }, COMPOSE)).toBe(
      'integrations: unknown key "jira" (allowed: linear, githubApp)',
    );
  });

  it("unknown keys refused in each block", () => {
    expect(failure({ linear: { enabled: true, clientId: "a", clientSecret: "s" } })).toBe(
      'integrations.linear: unknown key "clientSecret" (allowed: enabled, clientId)',
    );
    expect(failure({ slack: { enabled: true, channelId: "C1", botToken: "t" } })).toBe(
      'integrations.slack: unknown key "botToken" (allowed: enabled, channelId, notifySources)',
    );
    expect(failure({ githubApp: { enabled: false, privateKey: "s" } })).toBe(
      'integrations.githubApp: unknown key "privateKey" (allowed: enabled, appId, slug, installationId, botUserId, tokens, tokenScope, ciResults, tokenFile, org, pending)',
    );
  });
});

describe("enabledLinear", () => {
  it("is the block only when enabled", () => {
    const on = { enabled: true as const, clientId: "abc123" };
    expect(enabledLinear({ linear: on })).toEqual(on);
    expect(enabledLinear({ linear: { enabled: false, clientId: "abc123" } })).toBeUndefined();
    expect(enabledLinear({})).toBeUndefined();
  });
});

const APP = {
  enabled: true,
  appId: 123,
  slug: "example-devbox",
  installationId: 456,
  botUserId: 789,
  tokens: "devbox",
} as const;

describe("integrations.githubApp", () => {
  it("fills the defaults", () => {
    expect(parseIntegrations({ githubApp: APP }, fail, COMPOSE)).toEqual({
      githubApp: { ...APP, tokenScope: "repos", ciResults: true },
    });
    expect(parseIntegrations({ githubApp: APP }, fail, K8S)).toEqual({
      githubApp: { ...APP, tokenScope: "repos", ciResults: true },
    });
  });

  it("refuses an explicit null tokenScope or ciResults", () => {
    expect(failure({ githubApp: { ...APP, tokenScope: null } })).toBe(
      'integrations.githubApp.tokenScope: must be "repos" or "installation"',
    );
    expect(failure({ githubApp: { ...APP, ciResults: null } })).toBe(
      "integrations.githubApp.ciResults: must be true or false",
    );
  });

  it("keeps explicit tokenScope and ciResults", () => {
    expect(
      parseIntegrations(
        { githubApp: { ...APP, tokenScope: "installation", ciResults: false } },
        fail,
        K8S,
      ),
    ).toEqual({ githubApp: { ...APP, tokenScope: "installation", ciResults: false } });
    expect(failure({ githubApp: { ...APP, tokenScope: "all" } })).toBe(
      'integrations.githubApp.tokenScope: must be "repos" or "installation"',
    );
    expect(failure({ githubApp: { ...APP, ciResults: "yes" } })).toBe(
      "integrations.githubApp.ciResults: must be true or false",
    );
  });

  it("each required key is required when enabled", () => {
    for (const key of ["appId", "slug", "installationId", "botUserId", "tokens"]) {
      const { [key]: _omitted, ...rest } = APP as Record<string, unknown>;
      expect(failure({ githubApp: rest })).toBe(
        `integrations.githubApp.${key}: required when enabled is true`,
      );
    }
  });

  it("tokens must be devbox or external", () => {
    expect(failure({ githubApp: { ...APP, tokens: "other" } })).toBe(
      'integrations.githubApp.tokens: must be "devbox" or "external"',
    );
  });

  it("ids must be positive integers, slug non-empty", () => {
    for (const key of ["appId", "installationId", "botUserId"]) {
      for (const v of [0, -1, 1.5, "1", null]) {
        expect(failure({ githubApp: { ...APP, [key]: v } })).toBe(
          `integrations.githubApp.${key}: must be a positive integer`,
        );
      }
    }
    expect(failure({ githubApp: { ...APP, slug: " " } })).toBe(
      "integrations.githubApp.slug: must be a non-empty string",
    );
  });

  it("a disabled block may hold any subset, and present keys are still checked", () => {
    expect(parseIntegrations({ githubApp: { enabled: false, appId: 5 } }, fail, COMPOSE)).toEqual({
      githubApp: { enabled: false, appId: 5, tokenScope: "repos", ciResults: true },
    });
    expect(failure({ githubApp: { enabled: false, appId: 0 } })).toBe(
      "integrations.githubApp.appId: must be a positive integer",
    );
  });

  it("tokenFile is required with external tokens on Compose, when enabled", () => {
    expect(failure({ githubApp: { ...APP, tokens: "external" } }, COMPOSE)).toBe(
      'integrations.githubApp.tokenFile: required with tokens "external" on Compose',
    );
    expect(
      parseIntegrations(
        { githubApp: { ...APP, tokens: "external", tokenFile: "/run/gh/token" } },
        fail,
        COMPOSE,
      ),
    ).toEqual({
      githubApp: {
        ...APP,
        tokens: "external",
        tokenFile: "/run/gh/token",
        tokenScope: "repos",
        ciResults: true,
      },
    });
  });

  it("org is an optional non-empty string, on both platforms", () => {
    for (const platform of [COMPOSE, K8S]) {
      expect(
        parseIntegrations({ githubApp: { ...APP, org: "example-org" } }, fail, platform),
      ).toEqual({
        githubApp: { ...APP, tokenScope: "repos", ciResults: true, org: "example-org" },
      });
    }
    expect(failure({ githubApp: { ...APP, org: "" } })).toBe(
      "integrations.githubApp.org: must be a non-empty string",
    );
    expect(failure({ githubApp: { ...APP, org: 5 } })).toBe(
      "integrations.githubApp.org: must be a non-empty string",
    );
  });

  it("pending.publicUrl: the URL the new App was registered with, validated", () => {
    expect(
      parseIntegrations(
        {
          githubApp: {
            ...APP,
            pending: { appId: 124, slug: "n", publicUrl: "https://new.example.com/" },
          },
        },
        fail,
        COMPOSE,
      ).githubApp?.pending,
    ).toEqual({ appId: 124, slug: "n", publicUrl: "https://new.example.com" });
    expect(
      failure({
        githubApp: {
          ...APP,
          pending: { appId: 1, slug: "n", publicUrl: "http://new.example.com" },
        },
      }),
    ).toBe(
      "integrations.githubApp.pending.publicUrl: Webhooks need a public HTTPS URL: http://new.example.com uses http:, not https:",
    );
  });

  it("pending: a new App waiting for its install, on both platforms", () => {
    for (const platform of [COMPOSE, K8S]) {
      expect(
        parseIntegrations(
          {
            githubApp: { ...APP, pending: { appId: 124, slug: "new-devbox", org: "example-org" } },
          },
          fail,
          platform,
        ),
      ).toEqual({
        githubApp: {
          ...APP,
          tokenScope: "repos",
          ciResults: true,
          pending: { appId: 124, slug: "new-devbox", org: "example-org" },
        },
      });
    }
    expect(
      parseIntegrations(
        { githubApp: { ...APP, pending: { appId: 124, slug: "n" } } },
        fail,
        COMPOSE,
      ).githubApp?.pending,
    ).toEqual({ appId: 124, slug: "n" });
    expect(failure({ githubApp: { ...APP, pending: "x" } })).toBe(
      "integrations.githubApp.pending: must be an object",
    );
    expect(failure({ githubApp: { ...APP, pending: { slug: "n" } } })).toBe(
      "integrations.githubApp.pending.appId: must be a positive integer",
    );
    expect(failure({ githubApp: { ...APP, pending: { appId: 1, slug: "" } } })).toBe(
      "integrations.githubApp.pending.slug: must be a non-empty string",
    );
    expect(failure({ githubApp: { ...APP, pending: { appId: 1, slug: "n", org: "" } } })).toBe(
      "integrations.githubApp.pending.org: must be a non-empty string",
    );
    expect(failure({ githubApp: { ...APP, pending: { appId: 1, slug: "n", key: "k" } } })).toBe(
      'integrations.githubApp.pending: unknown key "key" (allowed: appId, slug, org, publicUrl)',
    );
  });

  it("a disabled external block without tokenFile parses", () => {
    expect(
      parseIntegrations({ githubApp: { enabled: false, tokens: "external" } }, fail, COMPOSE),
    ).toEqual({
      githubApp: { enabled: false, tokens: "external", tokenScope: "repos", ciResults: true },
    });
  });

  it("tokenFile must be absolute", () => {
    expect(
      failure({ githubApp: { ...APP, tokens: "external", tokenFile: "rel/token" } }, COMPOSE),
    ).toBe("integrations.githubApp.tokenFile: must be an absolute path");
  });

  it("tokenFile must sit in a directory of its own: not / or the home directory", () => {
    const own =
      "keep the token file in a directory of its own (its whole directory is mounted into the containers)";
    for (const tokenFile of ["/token", `${homedir()}/token`, `${homedir()}/sub/../token`]) {
      expect(failure({ githubApp: { ...APP, tokens: "external", tokenFile } }, COMPOSE)).toBe(
        `integrations.githubApp.tokenFile ${tokenFile}: ${own}`,
      );
    }
    expect(
      parseIntegrations(
        { githubApp: { ...APP, tokens: "external", tokenFile: `${homedir()}/gh/token` } },
        fail,
        COMPOSE,
      ).githubApp?.tokenFile,
    ).toBe(`${homedir()}/gh/token`);
  });

  it('tokenFile can\'t contain ":" or ","', () => {
    for (const tokenFile of ["/run/a:b/token", "/run/gh/a,b"]) {
      expect(failure({ githubApp: { ...APP, tokens: "external", tokenFile } }, COMPOSE)).toBe(
        `integrations.githubApp.tokenFile ${tokenFile}: the path can't contain ":" or ","`,
      );
    }
  });

  it("tokenFile is refused on Kubernetes", () => {
    expect(failure({ githubApp: { ...APP, tokenFile: "/run/gh/token" } })).toBe(
      "integrations.githubApp.tokenFile: Compose only; on Kubernetes use secrets.github.existingSecret",
    );
  });
});

describe("enabledGithubApp", () => {
  it("is the block only when enabled", () => {
    const on = { ...APP, tokenScope: "repos", ciResults: true } as const;
    expect(enabledGithubApp({ githubApp: on })).toEqual(on);
    expect(enabledGithubApp({ githubApp: { ...on, enabled: false } })).toBeUndefined();
    expect(enabledGithubApp({})).toBeUndefined();
  });
});
