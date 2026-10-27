import { describe, expect, it } from "bun:test";
import type { DevboxConfig } from "../up/config";
import { apiIngressUrl, chartValues, deepMerge, userValue, type Values } from "./values";

const cfg: DevboxConfig = {
  repos: [
    { url: "https://github.com/acme/widgets.git", branch: "main", owner: "acme", name: "widgets" },
  ],
  llm: { provider: "openai", baseUrl: "https://llm.example.com/v1", model: "gpt-test" },
  github: { trustedOrgs: [], trustedUsers: [] },
  integrations: {},
};
const user: Values = {
  storage: { storageClass: "gp3", volumeSnapshotClass: "ebs" },
  sandbox: { maxConcurrent: 3 },
  git: { name: "Bot" },
};
const identity = { gitName: "Ada", gitEmail: "1+ada@users.noreply.github.com" };

describe("chartValues", () => {
  it("adds repos, llm, the cluster IP, the URL and the identity under the user's values", () => {
    expect(
      chartValues(cfg, user, {
        clusterIP: "10.96.0.20",
        publicBaseUrl: "http://localhost:13000",
        identity,
      }),
    ).toEqual({
      repos: [{ url: "https://github.com/acme/widgets.git", branch: "main" }],
      llm: { provider: "openai", baseUrl: "https://llm.example.com/v1", model: "gpt-test" },
      ironProxy: { clusterIP: "10.96.0.20" },
      controlPlane: { publicBaseUrl: "http://localhost:13000" },
      git: { name: "Bot", email: "1+ada@users.noreply.github.com" },
      storage: { storageClass: "gp3", volumeSnapshotClass: "ebs" },
      sandbox: { maxConcurrent: 3 },
    });
  });

  it("copies configured LLM overrides and leaves omitted fields out", () => {
    expect(chartValues(cfg, {}, {}).llm).toEqual({
      provider: "openai",
      baseUrl: "https://llm.example.com/v1",
      model: "gpt-test",
    });
    expect(
      chartValues({ ...cfg, llm: { ...cfg.llm, stages: { review: {} } } }, {}, {}).llm,
    ).toEqual({
      provider: "openai",
      baseUrl: "https://llm.example.com/v1",
      model: "gpt-test",
    });
    expect(
      chartValues(
        {
          ...cfg,
          llm: {
            ...cfg.llm,
            reasoningEffort: "high",
            stages: {
              review: { model: "gpt-review", reasoningEffort: "xhigh" },
              orientation: { reasoningEffort: "minimal" },
            },
          },
        },
        {},
        {},
      ).llm,
    ).toEqual({
      provider: "openai",
      baseUrl: "https://llm.example.com/v1",
      model: "gpt-test",
      reasoningEffort: "high",
      stages: {
        review: { model: "gpt-review", reasoningEffort: "xhigh" },
        orientation: { reasoningEffort: "minimal" },
      },
    });
  });

  it("user chart values still win over installer LLM values", () => {
    expect(
      chartValues(
        { ...cfg, llm: { ...cfg.llm, reasoningEffort: "high" } },
        { llm: { reasoningEffort: "low", stages: { review: { model: "mine" } } } },
        {},
      ).llm,
    ).toEqual({
      provider: "openai",
      baseUrl: "https://llm.example.com/v1",
      model: "gpt-test",
      reasoningEffort: "low",
      stages: { review: { model: "mine" } },
    });
  });

  it("integrations copied, the App slug as botLogin", () => {
    expect(
      chartValues(
        cfg,
        {},
        {
          integrations: {
            linear: { enabled: true, clientId: "client-1" },
            slack: { enabled: false, channelId: "C123" },
            githubApp: {
              enabled: true,
              appId: 123,
              slug: "example-devbox",
              installationId: 456,
              botUserId: 789,
              tokens: "external",
              tokenScope: "installation",
              ciResults: false,
              org: "example-org",
              pending: { appId: 124, slug: "new-devbox" },
            },
          },
        },
      ),
    ).toEqual({
      repos: [{ url: "https://github.com/acme/widgets.git", branch: "main" }],
      llm: { provider: "openai", baseUrl: "https://llm.example.com/v1", model: "gpt-test" },
      integrations: {
        linear: { enabled: true, clientId: "client-1" },
        slack: { enabled: false, channelId: "C123" },
        githubApp: {
          enabled: true,
          appId: 123,
          botLogin: "example-devbox",
          installationId: 456,
          botUserId: 789,
          tokens: "external",
          tokenScope: "installation",
          ciResults: false,
        },
      },
    });
    expect(
      chartValues(cfg, {}, { integrations: { linear: { enabled: false } } }).integrations,
    ).toEqual({ linear: { enabled: false } });
    expect(chartValues(cfg, {}, { integrations: {} })).not.toHaveProperty("integrations");
  });

  it("a user value wins over the integrations", () => {
    expect(
      chartValues(
        cfg,
        { integrations: { linear: { clientId: "mine" } } },
        { integrations: { linear: { enabled: true, clientId: "client-1" } } },
      ).integrations,
    ).toEqual({ linear: { enabled: true, clientId: "mine" } });
  });

  it("puts an overlay between the installer's values and the user's", () => {
    expect(
      chartValues(
        cfg,
        user,
        {},
        { sandbox: { cpu: "1", maxConcurrent: 2 }, workspace: { size: "2Gi" } },
      ),
    ).toEqual({
      repos: [{ url: "https://github.com/acme/widgets.git", branch: "main" }],
      llm: { provider: "openai", baseUrl: "https://llm.example.com/v1", model: "gpt-test" },
      sandbox: { cpu: "1", maxConcurrent: 3 },
      workspace: { size: "2Gi" },
      storage: { storageClass: "gp3", volumeSnapshotClass: "ebs" },
      git: { name: "Bot" },
    });
  });
});

describe("deepMerge", () => {
  it("merges objects and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, e: 2 })).toEqual({
      a: { b: 1, c: [2] },
      d: 1,
      e: 2,
    });
  });
});

describe("userValue", () => {
  it("reads a nested user value", () => {
    expect(userValue({ values: user }, ["storage", "storageClass"])).toBe("gp3");
    expect(userValue({ values: user }, ["ironProxy", "clusterIP"])).toBeUndefined();
  });
});

describe("apiIngressUrl", () => {
  const tls = [{ hosts: ["devbox.example.com"], secretName: "t" }];
  const api = { enabled: true, host: "devbox.example.com" };
  const rows: [string, Values, string | undefined][] = [
    ["no ingress", {}, undefined],
    [
      "only webhooks",
      { ingress: { webhooks: { enabled: true, host: "hooks.example.com" } } },
      undefined,
    ],
    ["api without tls", { ingress: { api } }, "http://devbox.example.com"],
    ["api with tls", { ingress: { api: { ...api, tls } } }, "https://devbox.example.com"],
    [
      "both roles",
      { ingress: { api, webhooks: { enabled: true, host: "hooks.example.com" } } },
      "http://devbox.example.com",
    ],
    [
      "publicBaseUrl on the api host",
      { ingress: { api }, controlPlane: { publicBaseUrl: "https://devbox.example.com/" } },
      "https://devbox.example.com",
    ],
    [
      "publicBaseUrl on another host",
      { ingress: { api }, controlPlane: { publicBaseUrl: "https://links.example.com" } },
      "http://devbox.example.com",
    ],
    ["api disabled", { ingress: { api: { enabled: false, host: "x" } } }, undefined],
  ];
  for (const [name, values, want] of rows) {
    it(name, () => expect(apiIngressUrl({ values })).toBe(want));
  }
});
