// Values the chart must refuse, each with the message a user can act on.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHART, helmTemplate, integrationEnv, parseManifests, REGISTERED_ONLY, renderWith } from "./render";

const BASE = ["-f", join(import.meta.dir, "values", "base.yaml")];

async function failure(set: string[]): Promise<string> {
  const r = await helmTemplate([...BASE, ...set.flatMap((s) => ["--set", s])]);
  expect(r.code).not.toBe(0);
  return r.stderr;
}

describe("chart validation", () => {
  it.each([
    [["images.controlPlane="], "images.controlPlane is required: the control-plane image repository"],
    [["images.harness="], "images.harness is required: the harness image repository"],
    [["storage.storageClass="], "storage.storageClass is required: the StorageClass for task workspaces"],
    [["storage.volumeSnapshotClass="], "storage.volumeSnapshotClass is required"],
    [["ironProxy.clusterIP="], "ironProxy.clusterIP is required: a free address in the Service range"],
    [["llm.model="], "llm.baseUrl and llm.model are required"],
    [["postgresql.enabled=false"], "database.existingSecret is required when postgresql.enabled is false"],
    [["ingress.webhooks.enabled=true"], "ingress.webhooks.host is required when ingress.webhooks.enabled is true"],
    [["ingress.api.enabled=true"], "ingress.api.host is required when ingress.api.enabled is true"],
  ])("refuses %j", async (set, message) => {
    expect(await failure(set)).toContain(message);
  });

  it("refuses a release namespace other than devbox", async () => {
    const r = await helmTemplate(BASE, "default");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(
      "install the release in namespace devbox (sandboxes run in devbox-sandboxes)",
    );
  });

  it("refuses an unknown top-level value (a typo)", async () => {
    expect(await failure(["storageClass=gp3"])).toContain("storageClass");
  });

  it.each([
    ["ingress.enabled=true", "enabled"],
    ["ingress.paths=all", "paths"],
  ])("rejects the old flat ingress key %s through the schema", async (set, key) => {
    const stderr = await failure([set]);
    expect(stderr).toContain("values don't meet the specifications of the schema");
    expect(stderr).toContain(key);
  });

  it("refuses unknown keys under integrations.linear", async () => {
    const stderr = await failure(["integrations.linear.clientSecret=x"]);
    expect(stderr).toContain("values don't meet the specifications of the schema");
    expect(stderr).toContain("clientSecret");
  });

  it("refuses unknown keys under integrations", async () => {
    const stderr = await failure(["integrations.teams.enabled=true"]);
    expect(stderr).toContain("values don't meet the specifications of the schema");
    expect(stderr).toContain("teams");
  });

  it("refuses unknown keys under integrations.slack and integrations.githubApp", async () => {
    for (const [set, key] of [
      ["integrations.slack.token=x", "token"],
      ["integrations.githubApp.slug=example-devbox", "slug"],
      ["integrations.githubApp.tokenFile=/run/token", "tokenFile"],
    ] as const) {
      const stderr = await failure([set]);
      expect(stderr).toContain("values don't meet the specifications of the schema");
      expect(stderr).toContain(key);
    }
  });

  it("refuses an unknown task source in integrations.slack.notifySources", async () => {
    const stderr = await failure(["integrations.slack.notifySources={linear,github}"]);
    expect(stderr).toContain("values don't meet the specifications of the schema");
    expect(stderr).toContain("notifySources");
  });

  it("refuses the removed integrations.githubWebhooks", async () => {
    const stderr = await failure(["integrations.githubWebhooks.enabled=true"]);
    expect(stderr).toContain("values don't meet the specifications of the schema");
    expect(stderr).toContain("githubWebhooks");
  });

  it.each([
    ["integrations.githubApp.botUserId=1.5", "botUserId"],
    ["integrations.githubApp.appId=1.5", "appId"],
    ["integrations.githubApp.installationId=-1", "installationId"],
    ["integrations.githubApp.tokens=minted", "tokens"],
    ["integrations.githubApp.tokenScope=org", "tokenScope"],
    ["integrations.githubApp.ciResults=maybe", "ciResults"],
  ])("refuses %s through the schema", async (set, key) => {
    const stderr = await failure([set]);
    expect(stderr).toContain("values don't meet the specifications of the schema");
    expect(stderr).toContain(key);
  });

  const APP = {
    "integrations.githubApp.enabled": "true",
    "integrations.githubApp.appId": "123456",
    "integrations.githubApp.installationId": "7890123",
    "integrations.githubApp.botLogin": "example-devbox",
    "integrations.githubApp.botUserId": "1234567",
    "integrations.githubApp.tokens": "devbox",
  };
  const TRUST = ["github.trustedOrgs={example-org}"];
  const appWithout = (key: string) =>
    Object.entries(APP).filter(([k]) => k !== key).map(([k, v]) => `${k}=${v}`);
  const appSet = Object.entries(APP).map(([k, v]) => `${k}=${v}`);

  it.each([
    [["integrations.linear.enabled=true"], "integrations.linear.enabled is true: integrations.linear.clientId is required"],
    [["integrations.slack.enabled=true"], "integrations.slack.enabled is true: integrations.slack.channelId is required"],
    ...["appId", "installationId", "botLogin", "botUserId", "tokens"].map(
      (key) =>
        [
          [...appWithout(`integrations.githubApp.${key}`), ...TRUST],
          `integrations.githubApp.enabled is true: integrations.githubApp.${key} is required`,
        ] as [string[], string],
    ),
    [appSet, "integrations.githubApp.enabled is true: github.trustedOrgs or github.trustedUsers is required"],
    [
      [...appSet, ...TRUST, "secrets.github.existingSecret=example-github-token"],
      "integrations.githubApp.enabled is true: tokens: devbox writes the token Secret itself: remove secrets.github.existingSecret, or use tokens: external",
    ],
  ])("refuses %j", async (set, message) => {
    expect(await failure(set)).toContain(message);
  });

  it("accepts the GitHub App with only trustedUsers", async () => {
    const r = await helmTemplate([...BASE, ...[...appSet, "github.trustedUsers={alice}"].flatMap((s) => ["--set", s])]);
    expect(r.code).toBe(0);
  });

  it("accepts external tokens with the user's token Secret", async () => {
    const set = [
      ...appWithout("integrations.githubApp.tokens"),
      "integrations.githubApp.tokens=external",
      ...TRUST,
      "secrets.github.existingSecret=example-github-token",
    ];
    const r = await helmTemplate([...BASE, ...set.flatMap((s) => ["--set", s])]);
    expect(r.code).toBe(0);
  });

  it("accepts an App registered but not yet installed, and renders it as off", async () => {
    const r = await helmTemplate([...BASE, "--set-json", `integrations.githubApp=${JSON.stringify(REGISTERED_ONLY)}`]);
    expect(r.code).toBe(0);
    const docs = parseManifests(r.stdout);
    expect(Object.keys(docs).filter((k) => k.includes("devbox-github-token"))).toEqual([]);
    expect(integrationEnv(docs)).toEqual({});
  });

  it("refuses narrowed devbox tokens without repos", async () => {
    const r = await helmTemplate([...BASE, ...[...appSet, ...TRUST].flatMap((s) => ["--set", s]), "--set-json", "repos=[]"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(
      "integrations.githubApp.enabled is true: tokenScope: repos needs at least one entry in repos (or use tokenScope: installation)",
    );
  });

  it("refuses external tokens without the user's token Secret", async () => {
    const set = [...appWithout("integrations.githubApp.tokens"), "integrations.githubApp.tokens=external", ...TRUST];
    expect(await failure(set)).toContain(
      "integrations.githubApp.enabled is true: tokens: external needs secrets.github.existingSecret: the Secret your tooling keeps fresh",
    );
  });

  it("refuses an unknown provider", async () => {
    expect(await failure(["llm.provider=gemini"])).toContain("provider");
  });

  it("refuses the removed wireApi", async () => {
    expect(await failure(["llm.wireApi=chat"])).toContain("wireApi");
  });

  it("treats a null llm.stages as no overrides", async () => {
    const r = await renderWith(["base.yaml"], ["llm.stages=null"]);
    expect(r["Deployment/devbox/devbox-control-plane"]).toBeDefined();
  });

  it("refuses an unknown LLM stage through the schema", async () => {
    const stderr = await failure(["llm.stages.verification.model=gpt-test"]);
    expect(stderr).toContain("values don't meet the specifications of the schema");
    expect(stderr).toContain("verification");
  });

  it.each([
    ["openai", "llm.reasoningEffort=max", 'llm.reasoningEffort="max" is not a supported reasoning effort for provider openai; accepted: none, minimal, low, medium, high, xhigh'],
    ["anthropic", "llm.reasoningEffort=none", 'llm.reasoningEffort="none" is not a supported reasoning effort for provider anthropic; accepted: low, medium, high, xhigh, max'],
    ["anthropic", "llm.stages.planReview.reasoningEffort=minimal", 'llm.stages.planReview.reasoningEffort="minimal" is not a supported reasoning effort for provider anthropic; accepted: low, medium, high, xhigh, max'],
  ])("refuses provider-specific effort %s %s", async (provider, effort, message) => {
    const providerSettings = provider === "anthropic"
      ? ["llm.provider=anthropic", "llm.baseUrl=https://api.anthropic.com"]
      : ["llm.provider=openai"];
    expect(await failure([...providerSettings, effort])).toContain(message);
  });

  it.each([
    ["llm.reasoningEffort=High", "llm.reasoningEffort"],
    ["llm.stages.review.reasoningEffort=HIGH", "llm.stages.review.reasoningEffort"],
  ])("refuses non-lower-case effort %s", async (set, path) => {
    const stderr = await failure([set]);
    expect(stderr).toContain("values don't meet the specifications of the schema");
    expect(stderr).toContain(path.split(".").at(-1) as string);
  });

  it.each([
    ["empty stage", "llm.stages.planning.model="],
    ["whitespace-only stage", "llm.stages.planning.model=   "],
    ["whitespace-only global", "llm.model=   "],
  ])("refuses an %s model", async (_name, set) => {
    const stderr = await failure([set]);
    expect(stderr).toContain("model");
  });

  it.each(["/v1", "/v1/", "/proxy/v1"])(
    "refuses an anthropic base URL with the path %s",
    async (path) => {
      expect(
        await failure(["llm.provider=anthropic", `llm.baseUrl=https://api.anthropic.com${path}`]),
      ).toContain(
        "llm.baseUrl: for provider anthropic use the API root without /v1, for example https://api.anthropic.com",
      );
    },
  );

  it("vendors the pinned OpenSandbox chart", () => {
    const tgz = readFileSync(join(CHART, "charts", "opensandbox-0.2.2.tgz"));
    expect(createHash("sha256").update(tgz).digest("hex")).toBe(
      "2cab7593551d6887dedd110de1c582152b8139c0ed3390d04597f438d1d6d7c0",
    );
  });
});
