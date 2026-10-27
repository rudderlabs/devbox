// Renders the chart with `helm template` and parses the output into documents
// keyed by "<Kind>/<namespace>/<name>", so tests compare by key and value,
// never by order. HELM_BIN overrides the helm binary.
import { join } from "node:path";

export const CHART = join(import.meta.dir, "..");
const VALUES = join(import.meta.dir, "values");
const HELM = process.env.HELM_BIN ?? "helm";

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
export type Doc = Record<string, any>;
export type Rendered = Record<string, Doc>;

// Golden cases: each a list of values files under tests/values/, merged in order.
export const CASES: Record<string, string[]> = {
  defaults: ["base.yaml"],
  "byo-secrets": ["base.yaml", "byo-secrets.yaml"],
  "external-db": ["base.yaml", "external-db.yaml"],
  "sandbox-options": ["base.yaml", "sandbox-options.yaml"],
  "ingress-webhooks": ["base.yaml", "ingress-webhooks.yaml"],
  "ingress-api": ["base.yaml", "ingress-api.yaml"],
  "ingress-both": ["base.yaml", "ingress-both.yaml"],
  replicas: ["base.yaml", "replicas.yaml"],
  linear: ["base.yaml", "linear.yaml"],
  slack: ["base.yaml", "slack.yaml"],
  "github-app": ["base.yaml", "github-app.yaml"],
  "github-app-external": ["base.yaml", "github-app-external.yaml"],
  "llm-stages": ["base.yaml", "llm-stages.yaml"],
};

export async function helmTemplate(
  args: string[],
  namespace = "devbox",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([HELM, "template", "devbox", CHART, "--namespace", namespace, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export function parseManifests(text: string): Rendered {
  const out: Rendered = {};
  for (const chunk of text.split(/^---\s*$/m)) {
    const doc = Bun.YAML.parse(chunk) as Doc | null;
    if (!doc) continue;
    const key = `${doc.kind}/${doc.metadata?.namespace ?? ""}/${doc.metadata?.name}`;
    if (out[key]) throw new Error(`duplicate document ${key}`);
    out[key] = doc;
  }
  return out;
}

// The vendored chart's CRDs are upstream's, verbatim: not ours to pin.
export function withoutCrds(rendered: Rendered): Rendered {
  return Object.fromEntries(
    Object.entries(rendered).filter(([, doc]) => doc.kind !== "CustomResourceDefinition"),
  );
}

// `setJson` entries are `key=<json>` (helm --set-json), for lists and objects.
export async function renderWith(
  files: string[],
  set: string[] = [],
  setJson: string[] = [],
): Promise<Rendered> {
  const args = [
    ...files.flatMap((f) => ["-f", join(VALUES, f)]),
    ...set.flatMap((s) => ["--set", s]),
    ...setJson.flatMap((s) => ["--set-json", s]),
  ];
  const r = await helmTemplate(args);
  if (r.code !== 0) throw new Error(`helm template failed: ${r.stderr}`);
  return parseManifests(r.stdout);
}

export async function renderCase(name: string): Promise<Rendered> {
  const files = CASES[name];
  if (!files) throw new Error(`no golden case ${name}`);
  return renderWith(files);
}

// What setup leaves for an App it registered but could not install yet.
export const REGISTERED_ONLY = {
  enabled: false,
  appId: 123456,
  botLogin: "example-devbox",
  botUserId: 1234567,
  tokens: "devbox",
  tokenScope: "repos",
  ciResults: true,
};

// The control plane's integration env (everything but the token file), as a name -> value map.
export function integrationEnv(r: Rendered): Record<string, string> {
  const env: Doc[] = (r["Deployment/devbox/devbox-control-plane"] as Doc).spec.template.spec.containers[0].env;
  return Object.fromEntries(
    env.filter((e) => /^(LINEAR_|SLACK_|GITHUB_)/.test(e.name) && e.name !== "GITHUB_TOKEN_FILE").map((e) => [e.name, e.value]),
  );
}
