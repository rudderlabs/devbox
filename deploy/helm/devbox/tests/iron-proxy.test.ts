// iron-proxy on Kubernetes: the same allowlist and secret matching as the
// Compose renderer, file-sourced secrets, and a config change
// that rolls the pods.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  renderIronProxyConfig,
  TEMPLATE_PATH,
} from "../../../../control-plane/scripts/up/ironProxy";
import { type Doc, type Rendered, renderWith } from "./render";

const REPOS = [
  { url: "https://github.com/acme/widgets.git", branch: "main", owner: "acme", name: "widgets" },
  { url: "https://github.com/acme/gadgets.git", branch: "dev", owner: "acme", name: "gadgets" },
];
const setRepos = `repos=${JSON.stringify(REPOS.map(({ url, branch }) => ({ url, branch })))}`;

// One render: the chart's iron-proxy config, parsed, and all documents.
async function chartConfig(
  baseUrl: string,
  setJson: string[] = [],
  provider = "openai",
  set: string[] = [],
) {
  const rendered = await renderWith(
    ["base.yaml"],
    [`llm.provider=${provider}`, `llm.baseUrl=${baseUrl}`, ...set],
    [setRepos, ...setJson],
  );
  const cm = rendered["ConfigMap/devbox/devbox-iron-proxy-config"] as Doc;
  return { config: Bun.YAML.parse(cm.data["config.yaml"]) as Doc, rendered };
}

const withoutSource = (t: Doc) => t.config.secrets.map(({ source, ...rest }: Doc) => rest);

describe("iron-proxy config", () => {
  for (const [provider, baseUrl] of [
    ["openai", "https://llm.example.com/openai/v1"],
    ["openai", "https://llm.example.com"],
    ["anthropic", "https://api.anthropic.com"],
    ["anthropic", "https://gw.example.com/anthropic/"],
  ] as const) {
    it(`matches the Compose renderer (${provider}, ${baseUrl})`, async () => {
      const compose = Bun.YAML.parse(
        renderIronProxyConfig(
          readFileSync(TEMPLATE_PATH, "utf8"),
          {
            repos: REPOS,
            github: { trustedOrgs: ["example-org", "other-org"], trustedUsers: [] },
            llm: { provider, baseUrl: baseUrl.replace(/\/+$/, ""), model: "m" },
          },
          "1.1.1.1:53",
          { githubTokenSource: "file" },
        ),
      ) as Doc;
      const { config } = await chartConfig(baseUrl, [], provider, [
        "github.trustedOrgs={example-org,other-org}",
      ]);
      expect(config.transforms.map((t: Doc) => t.name)).toEqual(["allowlist", "secrets"]);
      expect(config.transforms[0]).toEqual(compose.transforms[0]);
      expect(withoutSource(config.transforms[1])).toEqual(withoutSource(compose.transforms[1]));
      expect(config.transforms[1].config.secrets.map((s: Doc) => s.source)).toEqual([
        { type: "file", path: "/var/run/devbox/github/token", ttl: "60s" },
        { type: "file", path: "/var/run/devbox/llm/api-key", ttl: "60s" },
      ]);
      expect(config.dns).toEqual({ listen: ":5353", proxy_ip: "10.96.0.20" });
      expect(config.proxy).toEqual({
        http_listen: ":8080",
        https_listen: ":8443",
        max_request_body_bytes: 10485760,
      });
    });
  }

  it("has no org rule without trusted orgs, but keeps the user and CI-log rules", async () => {
    const { config } = await chartConfig("https://llm.example.com/v1");
    const rules = config.transforms[0].config.rules as Doc[];
    expect(JSON.stringify(rules)).not.toContain("/orgs/");
    expect(rules).toContainEqual({
      host: "api.github.com",
      methods: ["GET", "HEAD"],
      paths: ["/users/*"],
    });
    expect(rules).toContainEqual({
      host: "*.blob.core.windows.net",
      methods: ["GET", "HEAD"],
      paths: ["/actions-results/*"],
    });
  });

  it("rejects a trusted org name that would widen the rule", async () => {
    for (const org of ["a/b", "a*"]) {
      await expect(
        chartConfig("https://llm.example.com/v1", [`github.trustedOrgs=${JSON.stringify([org])}`]),
      ).rejects.toThrow(/trustedOrgs/);
    }
  });

  it("appends extraAllowlist rules", async () => {
    const { config } = await chartConfig("https://llm.example.com/v1", [
      `ironProxy.extraAllowlist=${JSON.stringify([{ host: "registry.npmjs.org", methods: ["GET"], paths: ["/*"] }])}`,
    ]);
    expect(config.transforms[0].config.rules.at(-1)).toEqual({
      host: "registry.npmjs.org",
      methods: ["GET"],
      paths: ["/*"],
    });
  });

  it("rolls the pods when the config changes", async () => {
    const checksum = (r: Rendered) =>
      r["Deployment/devbox/devbox-iron-proxy"]?.spec.template.metadata.annotations[
        "checksum/config"
      ];
    const a = (await chartConfig("https://llm.example.com/v1")).rendered;
    const b = (await chartConfig("https://other.example.com/v1")).rendered;
    expect(checksum(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(checksum(a)).not.toBe(checksum(b));
  });
});
