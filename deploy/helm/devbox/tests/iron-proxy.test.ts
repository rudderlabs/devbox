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
  { url: "https://github.com/acme/widgets.git", branch: "main", host: "github", owner: "acme", name: "widgets" },
  { url: "https://github.com/acme/gadgets.git", branch: "dev", host: "github", owner: "acme", name: "gadgets" },
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

// Bun.YAML reads the chart's 0440 as decimal 440 (YAML 1.2 has no leading-zero octal).
const MODE_0440 = 440;

describe("iron-proxy config with a GitLab instance", () => {
  const GITLAB = [
    "gitlab.baseUrl=https://git.example.com/gitlab",
    "secrets.gitlab.existingSecret=my-gitlab-token",
  ];
  const repos = `repos=${JSON.stringify([
    { url: "https://github.com/acme/widgets.git", branch: "main" },
    { url: "https://git.example.com/gitlab/platform/backend/api.git", branch: "develop" },
  ])}`;

  // iron-proxy matched "/api/v4/projects/g/sg/p/..." (decoded) against a
  // "%2F" rule and rejected it, in the first live run on EKS.
  it("allows the project's git and API paths under the instance's URL root, and nothing else there", async () => {
    const { config } = await chartConfig("https://llm.example.com/v1", [repos], "openai", GITLAB);
    const rules = config.transforms[0].config.rules as Doc[];
    const gitlab = rules.filter((r) => r.host === "git.example.com");
    expect(gitlab).toEqual([
      { host: "git.example.com", paths: ["/gitlab/platform/backend/api/*", "/gitlab/platform/backend/api.git/*"] },
      {
        host: "git.example.com",
        // Decoded, not %2F: iron-proxy matches the decoded request path.
        paths: ["/gitlab/api/v4/projects/platform/backend/api", "/gitlab/api/v4/projects/platform/backend/api/*"],
      },
    ]);
    // The GitHub repo keeps its usual rules; the GitLab one gets none on github.com.
    expect(rules).toContainEqual({ host: "github.com", paths: ["/acme/widgets/*", "/acme/widgets.git/*"] });
    expect(JSON.stringify(rules.filter((r) => r.host !== "git.example.com"))).not.toContain("backend");
  });

  it("swaps the GitLab token on the Authorization header for that host only", async () => {
    const { config, rendered } = await chartConfig("https://llm.example.com/v1", [repos], "openai", GITLAB);
    const secrets = config.transforms[1].config.secrets as Doc[];
    expect(secrets.map((s) => s.source.path)).toEqual([
      "/var/run/devbox/github/token",
      "/var/run/devbox/gitlab/token",
      "/var/run/devbox/llm/api-key",
    ]);
    expect(secrets[1]).toEqual({
      source: { type: "file", path: "/var/run/devbox/gitlab/token", ttl: "60s" },
      proxy_value: "proxy-gitlab-dummy-token",
      match_headers: ["Authorization", "PRIVATE-TOKEN"],
      rules: [{ host: "git.example.com" }],
    });
    const spec = (rendered["Deployment/devbox/devbox-iron-proxy"] as Doc).spec.template.spec;
    expect(spec.volumes).toContainEqual({
      name: "gitlab",
      secret: { secretName: "my-gitlab-token", defaultMode: MODE_0440, items: [{ key: "token", path: "token" }] },
    });
    expect(spec.containers[0].volumeMounts).toContainEqual({
      name: "gitlab",
      mountPath: "/var/run/devbox/gitlab",
      readOnly: true,
    });
  });

  it("mounts an optional CA bundle for the proxy's own upstream connections", async () => {
    const { rendered } = await chartConfig("https://llm.example.com/v1", [repos], "openai", [
      ...GITLAB,
      "ironProxy.caBundle=corp-ca",
    ]);
    const deployment = rendered["Deployment/devbox/devbox-iron-proxy"] as Doc;
    const spec = deployment.spec.template.spec;
    expect(spec.containers[0].env).toEqual([{ name: "SSL_CERT_FILE", value: "/etc/devbox/ca/ca.crt" }]);
    expect(spec.containers[0].volumeMounts).toContainEqual({
      name: "ca-bundle",
      mountPath: "/etc/devbox/ca",
      readOnly: true,
    });
    expect(spec.volumes).toContainEqual({
      name: "ca-bundle",
      secret: { secretName: "corp-ca", defaultMode: MODE_0440, items: [{ key: "ca.crt", path: "ca.crt" }] },
    });
    expect(deployment.spec.template.metadata.annotations["checksum/ca-bundle"]).toMatch(/^[0-9a-f]{64}$/);
    // Without it: no env, no mount, as before.
    const plain = (await chartConfig("https://llm.example.com/v1")).rendered;
    const plainSpec = (plain["Deployment/devbox/devbox-iron-proxy"] as Doc).spec.template.spec;
    expect(plainSpec.containers[0].env).toBeUndefined();
    expect(JSON.stringify(plainSpec.volumes)).not.toContain("ca-bundle");
    expect(JSON.stringify(plainSpec.volumes)).not.toContain("gitlab");
  });

  it("lets the snapshot builder read the GitLab token Secret, and only with GitLab on", async () => {
    const names = (r: Rendered) =>
      (r["Role/devbox/devbox-snapshot-builder-token"] as Doc).rules[0].resourceNames;
    const { rendered } = await chartConfig("https://llm.example.com/v1", [repos], "openai", GITLAB);
    expect(names(rendered)).toEqual(["devbox-github", "my-gitlab-token"]);
    expect(names((await chartConfig("https://llm.example.com/v1")).rendered)).toEqual(["devbox-github"]);
  });

  it("tells the control plane and the snapshot builder about the instance", async () => {
    const { rendered } = await chartConfig("https://llm.example.com/v1", [repos], "openai", GITLAB);
    const envOf = (doc: Doc) =>
      Object.fromEntries(doc.spec.template.spec.containers[0].env.map((e: Doc) => [e.name, e.value]));
    expect(envOf(rendered["Deployment/devbox/devbox-control-plane"] as Doc).GITLAB_BASE_URL).toBe(
      "https://git.example.com/gitlab",
    );
    const builder = (rendered["Job/devbox-sandboxes/devbox-snapshot-builder-install"] as Doc).spec.template.spec
      .containers[0].env;
    expect(builder).toContainEqual({ name: "GITLAB_BASE_URL", value: "https://git.example.com/gitlab" });
    expect(builder).toContainEqual({ name: "GITLAB_SECRET", value: "my-gitlab-token" });
    const plain = (await chartConfig("https://llm.example.com/v1")).rendered;
    expect("GITLAB_BASE_URL" in envOf(plain["Deployment/devbox/devbox-control-plane"] as Doc)).toBe(false);
  });
});
