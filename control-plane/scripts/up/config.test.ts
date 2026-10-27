import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, parseConfig } from "./config";

const dir = mkdtempSync(join(tmpdir(), "devbox-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const APP_ON = {
  enabled: true,
  appId: 123,
  slug: "example-devbox",
  installationId: 456,
  botUserId: 789,
  tokens: "devbox",
} as const;

const valid = () => ({
  repos: [
    { url: "https://github.com/acme/app.git" },
    { url: "https://github.com/me/my_lib.js.git", branch: "release/1.x" },
  ],
  llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
});

describe("parseConfig", () => {
  it("fills in the defaults", () => {
    expect(parseConfig(valid())).toEqual({
      repos: [
        { url: "https://github.com/acme/app.git", branch: "main", owner: "acme", name: "app" },
        {
          url: "https://github.com/me/my_lib.js.git",
          branch: "release/1.x",
          owner: "me",
          name: "my_lib.js",
        },
      ],
      llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
      sandbox: { maxConcurrent: 5, cpu: "2", memory: "4Gi" },
      github: { trustedOrgs: [], trustedUsers: [] },
      integrations: {},
    });
  });

  it("fills omitted sandbox fields and accepts supported quantities", () => {
    expect(parseConfig({ ...valid(), sandbox: { maxConcurrent: 7 } }).sandbox).toEqual({
      maxConcurrent: 7,
      cpu: "2",
      memory: "4Gi",
    });
    expect(parseConfig({ ...valid(), sandbox: { cpu: "1.5", memory: "512Mi" } }).sandbox).toEqual({
      maxConcurrent: 5,
      cpu: "1.5",
      memory: "512Mi",
    });
    expect(parseConfig({ ...valid(), sandbox: { cpu: "500m", memory: "1Ti" } }).sandbox).toEqual({
      maxConcurrent: 5,
      cpu: "500m",
      memory: "1Ti",
    });
  });

  it("github trust lists default to empty and parse when given", () => {
    expect(parseConfig(valid()).github).toEqual({ trustedOrgs: [], trustedUsers: [] });
    expect(
      parseConfig({ ...valid(), github: { trustedOrgs: [" acme "], trustedUsers: ["me"] } }).github,
    ).toEqual({ trustedOrgs: ["acme"], trustedUsers: ["me"] });
  });

  it("githubApp enabled with one non-empty trust list parses", () => {
    const cfg = parseConfig({
      ...valid(),
      github: { trustedUsers: ["me"] },
      integrations: { githubApp: APP_ON },
    });
    expect(cfg.integrations.githubApp).toEqual({ ...APP_ON, tokenScope: "repos", ciResults: true });
  });

  it("a disabled githubApp needs no trust list", () => {
    expect(
      parseConfig({ ...valid(), integrations: { githubApp: { enabled: false } } }).integrations,
    ).toEqual({ githubApp: { enabled: false, tokenScope: "repos", ciResults: true } });
  });

  it("a config without integrations has {}", () => {
    expect(parseConfig(valid()).integrations).toEqual({});
  });

  it("integrations.linear is parsed", () => {
    const raw = {
      ...valid(),
      integrations: { linear: { enabled: true, clientId: "client-1" } },
    };
    expect(parseConfig(raw).integrations).toEqual({
      linear: { enabled: true, clientId: "client-1" },
    });
  });

  it("the top-level publicUrl is validated and trimmed", () => {
    expect(parseConfig({ ...valid(), publicUrl: "https://devbox.example.com/" }).publicUrl).toBe(
      "https://devbox.example.com",
    );
    expect(parseConfig(valid()).publicUrl).toBeUndefined();
  });

  it("keeps explicit optional values and trims the base URL's trailing slash", () => {
    const raw = {
      ...valid(),
      llm: {
        provider: "openai",
        baseUrl: "https://res.openai.azure.com/openai/v1/",
        model: "deployment",
      },
    };
    const cfg = parseConfig(raw);
    expect(cfg.llm).toEqual({
      provider: "openai",
      baseUrl: "https://res.openai.azure.com/openai/v1",
      model: "deployment",
    });
  });

  it("accepts the anthropic provider at the API root", () => {
    const raw = {
      ...valid(),
      llm: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/",
        model: "claude-opus-5-5",
      },
    };
    expect(parseConfig(raw).llm).toEqual({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5-5",
    });
  });

  it("accepts an anthropic gateway path without a /v1 segment", () => {
    const raw = {
      ...valid(),
      llm: { provider: "anthropic", baseUrl: "https://gw.example/anthropic/v1beta", model: "m" },
    };
    expect(parseConfig(raw).llm.baseUrl).toBe("https://gw.example/anthropic/v1beta");
  });

  it("parses global and per-stage model settings without normalizing efforts", () => {
    expect(
      parseConfig({
        ...valid(),
        llm: {
          ...valid().llm,
          reasoningEffort: "high",
          stages: {
            review: { model: " pro ", reasoningEffort: "xhigh" },
            orientation: { reasoningEffort: "minimal" },
          },
        },
      }).llm,
    ).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      stages: {
        review: { model: "pro", reasoningEffort: "xhigh" },
        orientation: { reasoningEffort: "minimal" },
      },
    });
    expect(
      parseConfig({
        ...valid(),
        llm: {
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude",
          reasoningEffort: "max",
          stages: { planning: { reasoningEffort: "low" } },
        },
      }).llm.reasoningEffort,
    ).toBe("max");
  });

  const bad: Array<[string, (raw: Record<string, unknown>) => void, string]> = [
    [
      "a non-list repos",
      (r) => Object.assign(r, { repos: "x" }),
      "repos: must be a non-empty list",
    ],
    ["empty repos", (r) => Object.assign(r, { repos: [] }), "repos: must be a non-empty list"],
    [
      "a non-GitHub URL",
      (r) => Object.assign(r, { repos: [{ url: "https://gitlab.com/a/b.git" }] }),
      "repos[0].url: must be https://github.com/<owner>/<repo>.git, got https://gitlab.com/a/b.git",
    ],
    [
      "a URL without .git",
      (r) => Object.assign(r, { repos: [{ url: "https://github.com/a/b" }] }),
      "repos[0].url: must be https://github.com/<owner>/<repo>.git, got https://github.com/a/b",
    ],
    [
      "a path-traversal repo name",
      (r) => Object.assign(r, { repos: [{ url: "https://github.com/a/...git" }] }),
      'repos[0].url: bad repo name ".."',
    ],
    [
      "a repo name starting with -",
      (r) => Object.assign(r, { repos: [{ url: "https://github.com/a/-x.git" }] }),
      'repos[0].url: bad repo name "-x"',
    ],
    [
      "a duplicate repo name",
      (r) =>
        Object.assign(r, {
          repos: [{ url: "https://github.com/a/x.git" }, { url: "https://github.com/b/x.git" }],
        }),
      'repos[1].url: another repo is also named "x" (each repo is cloned to /workspace/<repo>)',
    ],
    [
      "a branch starting with -",
      (r) =>
        Object.assign(r, { repos: [{ url: "https://github.com/a/x.git", branch: "--upload" }] }),
      'repos[0].branch: bad branch "--upload"',
    ],
    [
      "a branch containing ..",
      (r) => Object.assign(r, { repos: [{ url: "https://github.com/a/x.git", branch: "a..b" }] }),
      'repos[0].branch: bad branch "a..b"',
    ],
    ["a missing llm", (r) => Object.assign(r, { llm: undefined }), "llm: required"],
    [
      "a non-http(s) base URL",
      (r) => Object.assign(r, { llm: { baseUrl: "ftp://x/v1", model: "m" } }),
      "llm.baseUrl: must be an http(s) URL, got ftp://x/v1",
    ],
    [
      "an unparsable base URL",
      (r) => Object.assign(r, { llm: { baseUrl: "openai", model: "m" } }),
      "llm.baseUrl: must be an http(s) URL, got openai",
    ],
    [
      "a base URL with a non-default port",
      (r) => Object.assign(r, { llm: { baseUrl: "http://ollama.lan:11434/v1", model: "m" } }),
      "llm.baseUrl: must use the default port (80 or 443), got 11434",
    ],
    [
      "a missing model",
      (r) => Object.assign(r, { llm: { baseUrl: "https://api.openai.com/v1" } }),
      "llm.model: required",
    ],
    [
      "an unknown stage",
      (r) => Object.assign(r, { llm: { ...valid().llm, stages: { coding: {} } } }),
      "llm.stages.coding: unknown stage",
    ],
    ...["toString", "constructor", "__proto__"].map(
      (stage): [string, (raw: Record<string, unknown>) => void, string] => [
        `an inherited Object property stage name ${stage}`,
        (r) =>
          Object.assign(r, {
            llm: { ...valid().llm, stages: JSON.parse(`{"${stage}":{"model":"gpt-bogus"}}`) },
          }),
        `llm.stages.${stage}: unknown stage`,
      ],
    ),
    ...["reasoningeffort", "stage"].map(
      (key): [string, (raw: Record<string, unknown>) => void, string] => [
        `a misspelled llm key ${key}`,
        (r) => Object.assign(r, { llm: { ...valid().llm, [key]: "high" } }),
        `llm.${key}: unknown field (allowed: provider, baseUrl, model, reasoningEffort, stages)`,
      ],
    ),
    [
      "an unknown stage field",
      (r) => Object.assign(r, { llm: { ...valid().llm, stages: { review: { effort: "high" } } } }),
      "llm.stages.review.effort: unknown field (allowed: model, reasoningEffort)",
    ],
    [
      "an empty stage model",
      (r) => Object.assign(r, { llm: { ...valid().llm, stages: { review: { model: " " } } } }),
      "llm.stages.review.model: must be a non-empty string",
    ],
    [
      "max effort with openai",
      (r) => Object.assign(r, { llm: { ...valid().llm, reasoningEffort: "max" } }),
      'llm.reasoningEffort: must be one of none, minimal, low, medium, high, xhigh for provider openai, got "max"',
    ],
    [
      "none effort with anthropic",
      (r) =>
        Object.assign(r, {
          llm: {
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "m",
            stages: { review: { reasoningEffort: "none" } },
          },
        }),
      'llm.stages.review.reasoningEffort: must be one of low, medium, high, xhigh, max for provider anthropic, got "none"',
    ],
    ...["High", " high"].map((effort): [string, (raw: Record<string, unknown>) => void, string] => [
      `effort ${JSON.stringify(effort)}`,
      (r) =>
        Object.assign(r, {
          llm: { ...valid().llm, stages: { planning: { reasoningEffort: effort } } },
        }),
      `llm.stages.planning.reasoningEffort: must be one of none, minimal, low, medium, high, xhigh for provider openai, got ${JSON.stringify(effort)}`,
    ]),
    [
      "the removed wireApi",
      (r) =>
        Object.assign(r, {
          llm: { baseUrl: "https://api.openai.com/v1", model: "m", wireApi: "responses" },
        }),
      'llm.wireApi: no longer supported; provider "openai" always uses the Responses API',
    ],
    [
      "an unknown provider",
      (r) =>
        Object.assign(r, {
          llm: { provider: "gemini", baseUrl: "https://api.example.com", model: "m" },
        }),
      'llm.provider: must be "openai" or "anthropic", got "gemini"',
    ],
    [
      "a provider in the wrong case",
      (r) =>
        Object.assign(r, {
          llm: { provider: "Anthropic", baseUrl: "https://api.anthropic.com", model: "m" },
        }),
      'llm.provider: must be "openai" or "anthropic", got "Anthropic"',
    ],
    ...["/v1", "/v1/", "/v1/messages", "/proxy/v1"].map(
      (path): [string, (raw: Record<string, unknown>) => void, string] => [
        `an anthropic base URL with the path ${path}`,
        (r) =>
          Object.assign(r, {
            llm: { provider: "anthropic", baseUrl: `https://api.anthropic.com${path}`, model: "m" },
          }),
        'llm.baseUrl: for provider "anthropic" use the API root without /v1, for example https://api.anthropic.com',
      ],
    ),
    [
      "an unknown key in integrations.linear",
      (r) =>
        Object.assign(r, { integrations: { linear: { enabled: true, clientId: "a", extra: 1 } } }),
      'integrations.linear: unknown key "extra" (allowed: enabled, clientId)',
    ],
    [
      "integrations.slack (Kubernetes only)",
      (r) => Object.assign(r, { integrations: { slack: { enabled: true, channelId: "C1" } } }),
      "integrations.slack: supported on Kubernetes only (the target file)",
    ],
    [
      "a leftover integrations.githubWebhooks",
      (r) => Object.assign(r, { integrations: { githubWebhooks: { enabled: false } } }),
      "integrations.githubWebhooks: replaced by integrations.githubApp; run bun run github:setup",
    ],
    [
      "github.trustedOrgs not a list",
      (r) => Object.assign(r, { github: { trustedOrgs: "acme" } }),
      "github.trustedOrgs: must be a list of non-empty strings",
    ],
    [
      "github.trustedUsers with an empty string",
      (r) => Object.assign(r, { github: { trustedUsers: ["me", " "] } }),
      "github.trustedUsers[1]: must be a non-empty string",
    ],
    ["github not an object", (r) => Object.assign(r, { github: [] }), "github: must be an object"],
    [
      "an unknown github key",
      (r) => Object.assign(r, { github: { trustedTeams: [] } }),
      'github: unknown key "trustedTeams" (allowed: trustedOrgs, trustedUsers)',
    ],
    [
      "sandbox not an object",
      (r) => Object.assign(r, { sandbox: [] }),
      "sandbox: must be an object",
    ],
    [
      "an unknown sandbox key",
      (r) => Object.assign(r, { sandbox: { replicas: 2 } }),
      'sandbox: unknown key "replicas" (allowed: maxConcurrent, cpu, memory)',
    ],
    ...[null, 0, -1, 1.5, "2"].map(
      (value): [string, (raw: Record<string, unknown>) => void, string] => [
        `sandbox.maxConcurrent ${JSON.stringify(value)}`,
        (r) => Object.assign(r, { sandbox: { maxConcurrent: value } }),
        "sandbox.maxConcurrent: must be an integer greater than or equal to 1",
      ],
    ),
    ...[null, 0, "0", ".5", "1e3", "500M", " 2"].map(
      (value): [string, (raw: Record<string, unknown>) => void, string] => [
        `sandbox.cpu ${JSON.stringify(value)}`,
        (r) => Object.assign(r, { sandbox: { cpu: value } }),
        'sandbox.cpu: must be a positive CPU quantity such as "2", "1.5" or "500m"',
      ],
    ),
    ...[null, 0, "0Gi", "4G", "1.5Gi", "512mi", " 4Gi"].map(
      (value): [string, (raw: Record<string, unknown>) => void, string] => [
        `sandbox.memory ${JSON.stringify(value)}`,
        (r) => Object.assign(r, { sandbox: { memory: value } }),
        'sandbox.memory: must be a positive binary memory quantity such as "512Mi" or "4Gi"',
      ],
    ),
    [
      "githubApp enabled with no trust list",
      (r) => Object.assign(r, { integrations: { githubApp: APP_ON } }),
      "integrations.githubApp: needs github.trustedOrgs or github.trustedUsers (who may drive the agent from GitHub)",
    ],
    [
      "githubApp enabled with both trust lists empty",
      (r) =>
        Object.assign(r, {
          github: { trustedOrgs: [], trustedUsers: [] },
          integrations: { githubApp: APP_ON },
        }),
      "integrations.githubApp: needs github.trustedOrgs or github.trustedUsers (who may drive the agent from GitHub)",
    ],
    [
      "a private publicUrl",
      (r) => Object.assign(r, { publicUrl: "https://192.168.1.1" }),
      "publicUrl: Webhooks need a public HTTPS URL: 192.168.1.1 is a private (RFC 1918) address",
    ],
    [
      "a non-string publicUrl",
      (r) => Object.assign(r, { publicUrl: 3 }),
      "publicUrl: must be a string",
    ],
    [
      "integrations.linear.publicUrl (moved)",
      (r) =>
        Object.assign(r, {
          integrations: {
            linear: { enabled: true, clientId: "a", publicUrl: "https://devbox.example.com" },
          },
        }),
      'integrations.linear: unknown key "publicUrl" (allowed: enabled, clientId); moved to the top-level publicUrl',
    ],
  ];
  for (const [name, mutate, message] of bad) {
    it(`rejects ${name}, naming the field`, () => {
      const raw: Record<string, unknown> = valid();
      mutate(raw);
      expect(() => parseConfig(raw)).toThrow(new ConfigError(`devbox.config.json: ${message}`));
    });
  }

  it("rejects a top level that is not an object", () => {
    expect(() => parseConfig([])).toThrow(
      new ConfigError("devbox.config.json: must be a JSON object"),
    );
  });
});

describe("loadConfig", () => {
  it("reads and parses the file", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify(valid()));
    expect(loadConfig(path)).toEqual(parseConfig(valid()));
  });

  it("says to copy the example when the file is missing", () => {
    expect(() => loadConfig(join(dir, "missing.json"))).toThrow(
      new ConfigError("devbox.config.json not found — copy devbox.config.example.json"),
    );
  });

  it("with { integrations: false } skips the integrations block, even an invalid one (k8s)", () => {
    const path = join(dir, "bad-integrations.json");
    writeFileSync(
      path,
      JSON.stringify({ ...valid(), integrations: { linear: { clientId: "", nope: 1 } } }),
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(loadConfig(path, { integrations: false })).toEqual(
      parseConfig(valid(), { integrations: false }),
    );
  });

  it("with { integrations: false } does not parse publicUrl (k8s)", () => {
    const path = join(dir, "bad-public-url.json");
    writeFileSync(path, JSON.stringify({ ...valid(), publicUrl: "https://192.168.1.1" }));
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(loadConfig(path, { integrations: false })).toEqual(
      parseConfig(valid(), { integrations: false }),
    );
  });

  it("with { integrations: false } skips and omits sandbox, even when invalid (k8s)", () => {
    for (const sandbox of [[], { maxConcurrent: 0, extra: true }]) {
      const cfg = parseConfig({ ...valid(), sandbox }, { integrations: false });
      expect(cfg).not.toHaveProperty("sandbox");
    }
  });

  it("names the file when it is not JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ repos: ");
    expect(() => loadConfig(path)).toThrow(new ConfigError("devbox.config.json: not valid JSON"));
  });
});
