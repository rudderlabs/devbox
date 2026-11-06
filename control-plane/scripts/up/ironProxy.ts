// Renders infra/local/iron-proxy.yaml from the template and devbox.config.json:
// the allowlist and secret matching cover exactly the configured repos (on
// GitHub, and on the GitLab instance when one is configured) and the LLM host.
// The chart renders the same rules (templates/iron-proxy-config.yaml); its
// tests compare the two.
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { DevboxConfig, GitlabConfig } from "./config";

export const TEMPLATE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "infra",
  "local",
  "iron-proxy.template.yaml",
);
export const OUTPUT_PATH = join(import.meta.dir, "..", "..", "infra", "local", "iron-proxy.yaml");

type Rule = { host: string; methods?: string[]; paths?: string[] };
type Secret = {
  source: { type: string; var?: string; path?: string; ttl?: string };
  proxy_value?: string;
  match_headers?: string[];
  rules: Array<{ host: string }>;
};
type IronProxyConfig = {
  dns: { upstream_resolver: string };
  transforms: Array<{
    name: string;
    config: { rules?: Rule[]; secrets?: Secret[] };
  }>;
};

export const DEFAULT_DNS_RESOLVER = "1.1.1.1:53";
// <host>:<port>; the host may be an IPv6 literal in brackets.
export const DNS_RESOLVER = /^[A-Za-z0-9.:[\]-]+:\d{1,5}$/;

// GitHub org logins are alphanumerics and hyphens. Anything else (a "/" or "*")
// would widen the /orgs/<org>/members path, so it is rejected, not escaped.
const ORG_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export const GITHUB_TOKEN_FILE = "/var/run/devbox/github/token";
export const GITLAB_TOKEN_PLACEHOLDER = "proxy-gitlab-dummy-token";

export const llmHost = (baseUrl: string): string => new URL(baseUrl).hostname;

// The GitLab instance's host and URL-root prefix ("" or "/gitlab"), as the
// chart's devbox.gitlabHost and devbox.gitlabPrefix helpers derive them.
export function gitlabHostAndPrefix(baseUrl: string): { host: string; prefix: string } {
  const u = new URL(baseUrl);
  return { host: u.hostname, prefix: u.pathname.replace(/\/+$/, "") };
}

// The one endpoint the harness calls, so a sandbox cannot use the real key on
// any other path of the LLM host (files, batches, admin): the Responses API
// under the base URL for openai, the Messages API under the API root for
// anthropic. A pattern without "*" matches that exact path.
export function llmPath(llm: Pick<DevboxConfig["llm"], "provider" | "baseUrl">): string {
  const path = new URL(llm.baseUrl).pathname.replace(/\/+$/, "");
  return llm.provider === "anthropic" ? `${path}/v1/messages` : `${path}/responses`;
}

function transform(doc: IronProxyConfig, name: string) {
  const t = doc.transforms.find((x) => x.name === name);
  if (!t) throw new Error(`iron-proxy template has no "${name}" transform`);
  return t.config;
}

export function renderIronProxyConfig(
  template: string,
  cfg: Pick<DevboxConfig, "repos" | "llm"> & {
    github: Pick<DevboxConfig["github"], "trustedOrgs" | "trustedUsers">;
    gitlab?: Pick<GitlabConfig, "baseUrl" | "trustedGroups">;
  },
  dnsResolver: string,
  opts: {
    githubTokenSource: "env" | "file";
    // With the file source: the token's path inside the container.
    githubTokenFile?: string;
  } = { githubTokenSource: "env" },
): string {
  const doc = parse(template) as IronProxyConfig;
  const host = llmHost(cfg.llm.baseUrl);
  doc.dns.upstream_resolver = dnsResolver;

  const rules = transform(doc, "allowlist").rules;
  if (!rules) throw new Error("iron-proxy template: allowlist has no rules");
  const gl = cfg.gitlab ? gitlabHostAndPrefix(cfg.gitlab.baseUrl) : undefined;
  for (const { host: repoHost, owner, name } of cfg.repos) {
    if (repoHost === "gitlab") {
      if (!gl) throw new Error(`repo ${owner}/${name} is on GitLab but gitlab.baseUrl is not set`);
      // A GitLab project: git over HTTPS (info/refs, git-upload-pack and
      // git-receive-pack under <project>.git) and its REST API. Clients send
      // the project path as one URL-encoded segment (group%2Fproject), but
      // iron-proxy matches the decoded path, so the rule spells it out.
      const path = `${owner}/${name}`;
      rules.push(
        { host: gl.host, paths: [`${gl.prefix}/${path}/*`, `${gl.prefix}/${path}.git/*`] },
        {
          host: gl.host,
          paths: [`${gl.prefix}/api/v4/projects/${path}`, `${gl.prefix}/api/v4/projects/${path}/*`],
        },
      );
      continue;
    }
    // Git over HTTPS uses /<owner>/<repo>.git/... (or without .git); a "*"
    // inside a segment would not reach below it.
    rules.push(
      { host: "github.com", paths: [`/${owner}/${name}/*`, `/${owner}/${name}.git/*`] },
      { host: "api.github.com", paths: [`/repos/${owner}/${name}/*`] },
      { host: "raw.githubusercontent.com", paths: [`/${owner}/${name}/*`] },
    );
  }
  // Read-only trust lookups (membership of each trusted org, user profiles) and
  // CI log downloads (Actions log archives redirect to Azure blob storage).
  for (const org of cfg.github.trustedOrgs) {
    if (!ORG_LOGIN.test(org)) {
      throw new Error(
        `github.trustedOrgs: trusted org ${JSON.stringify(org)} is not a GitHub login`,
      );
    }
  }
  if (cfg.github.trustedOrgs.length > 0) {
    rules.push({
      host: "api.github.com",
      methods: ["GET", "HEAD"],
      paths: cfg.github.trustedOrgs.map((org) => `/orgs/${org}/members`),
    });
  }
  rules.push({ host: "api.github.com", methods: ["GET", "HEAD"], paths: ["/users/*"] });
  if (gl && cfg.gitlab) {
    // Trust lookups on GitLab: a trusted group's members (inherited ones
    // included) and a username's id. Group paths decoded, as above.
    rules.push({
      host: gl.host,
      methods: ["GET", "HEAD"],
      paths: [
        ...(cfg.gitlab.trustedGroups ?? []).map(
          (g) => `${gl.prefix}/api/v4/groups/${g}/members/all`,
        ),
        `${gl.prefix}/api/v4/users`,
      ],
    });
  }
  rules.push({
    host: "*.blob.core.windows.net",
    methods: ["GET", "HEAD"],
    paths: ["/actions-results/*"],
  });
  rules.push({ host, methods: ["POST"], paths: [llmPath(cfg.llm)] });

  if (opts.githubTokenSource === "file") {
    const ghSecret = transform(doc, "secrets").secrets?.find(
      (s) => s.source.var === "GITHUB_TOKEN",
    );
    if (!ghSecret) throw new Error("iron-proxy template: no GITHUB_TOKEN secret");
    ghSecret.source = {
      type: "file",
      path: opts.githubTokenFile ?? GITHUB_TOKEN_FILE,
      ttl: "60s",
    };
  }

  const secrets = transform(doc, "secrets").secrets;
  const llmSecret = secrets?.find((s) => s.source.var === "LLM_API_KEY");
  if (!secrets || !llmSecret) throw new Error("iron-proxy template: no LLM_API_KEY secret");
  llmSecret.rules = [{ host }];
  if (gl) {
    // The GitLab token, before the LLM key as in the chart. git sends the
    // placeholder as a Basic password, the harness as a Bearer token: both on
    // the Authorization header.
    secrets.splice(secrets.indexOf(llmSecret), 0, {
      source: { type: "env", var: "GITLAB_TOKEN" },
      proxy_value: GITLAB_TOKEN_PLACEHOLDER,
      match_headers: ["Authorization", "PRIVATE-TOKEN"],
      rules: [{ host: gl.host }],
    });
  }

  return `# Generated by \`bun run up\` from iron-proxy.template.yaml and devbox.config.json.\n# Do not edit: the next \`bun run up\` overwrites it.\n${stringify(doc)}`;
}
