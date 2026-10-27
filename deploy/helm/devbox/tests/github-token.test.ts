// The GitHub App's token minter: with `tokens: devbox` a Deployment refreshes
// the devbox-github Secret and a hook Job mints the first token; with
// `tokens: external` the user's tooling keeps the Secret fresh.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type Doc, helmTemplate, integrationEnv, REGISTERED_ONLY, type Rendered, renderWith } from "./render";

const LABELS = {
  "app.kubernetes.io/part-of": "devbox",
  "app.kubernetes.io/managed-by": "Helm",
  "helm.sh/chart": "devbox-0.1.0",
};
// Bun parses YAML 1.2, where the chart's octal 0440 reads as the decimal 440;
// the API server (YAML 1.1) reads it as octal. The raw text is checked below.
const MODE_0440 = 440;
const meta = (name: string, extra: Doc = {}) => ({ name, namespace: "devbox", labels: LABELS, ...extra });

const ENV = (repositories: string) => [
  { name: "GITHUB_APP_ID", value: "123456" },
  { name: "GITHUB_APP_INSTALLATION_ID", value: "7890123" },
  { name: "GITHUB_APP_PRIVATE_KEY_FILE", value: "/var/run/devbox/github-app/private-key" },
  { name: "GITHUB_APP_REPOSITORIES", value: repositories },
  { name: "GITHUB_TOKEN_SINK", value: "secret:devbox/devbox-github" },
];

const podSpec = (component: string, command: string[], restartPolicy?: string) => ({
  ...(restartPolicy ? { restartPolicy } : {}),
  serviceAccountName: "devbox-github-token",
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
  containers: [
    {
      name: component,
      image: "rudderlabs/devbox-control-plane:0.1.0",
      imagePullPolicy: "IfNotPresent",
      command,
      env: ENV("widgets"),
      resources: { requests: { cpu: "50m", memory: "64Mi" } },
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      volumeMounts: [{ name: "github-app-key", mountPath: "/var/run/devbox/github-app", readOnly: true }],
    },
  ],
  volumes: [
    {
      name: "github-app-key",
      secret: {
        secretName: "devbox-github-app",
        defaultMode: MODE_0440,
        items: [{ key: "private-key", path: "private-key" }],
      },
    },
  ],
});

const MINTER_KINDS = [
  "Deployment/devbox/devbox-github-token",
  "Job/devbox/devbox-github-token-seed",
  "NetworkPolicy/devbox/devbox-github-token",
  "Role/devbox/devbox-github-token",
  "RoleBinding/devbox/devbox-github-token",
  "ServiceAccount/devbox/devbox-github-token",
];
const minterDocs = (r: Rendered) => Object.keys(r).filter((k) => k.endsWith("/devbox-github-token") || k.endsWith("/devbox-github-token-seed")).sort();

// Every pod spec in the release with its document key.
function podSpecs(r: Rendered): [string, Doc][] {
  return Object.entries(r).flatMap(([key, doc]): [string, Doc][] => {
    if (doc.kind === "CronJob") return [[key, doc.spec.jobTemplate.spec.template.spec]];
    if (["Deployment", "StatefulSet", "DaemonSet", "Job"].includes(doc.kind)) return [[key, doc.spec.template.spec]];
    return [];
  });
}

describe("GitHub App token minter", () => {
  it("renders the minter Deployment", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"]);
    expect(r["Deployment/devbox/devbox-github-token"]).toEqual({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta("devbox-github-token"),
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { "app.kubernetes.io/part-of": "devbox", "app.kubernetes.io/component": "github-token" } },
        template: {
          metadata: { labels: { "app.kubernetes.io/part-of": "devbox", "app.kubernetes.io/component": "github-token" } },
          spec: podSpec("github-token", ["bun", "run", "github-token"]),
        },
      },
    });
  });

  it("renders the seed hook Job", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"]);
    expect(r["Job/devbox/devbox-github-token-seed"]).toEqual({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: meta("devbox-github-token-seed", {
        annotations: {
          "helm.sh/hook": "post-install,post-upgrade",
          "helm.sh/hook-weight": "0",
          "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded",
        },
      }),
      spec: {
        ttlSecondsAfterFinished: 600,
        backoffLimit: 0,
        template: {
          metadata: { labels: { "app.kubernetes.io/part-of": "devbox", "app.kubernetes.io/component": "github-token-seed" } },
          spec: podSpec("github-token-seed", ["bun", "run", "github-token", "--once"], "Never"),
        },
      },
    });
  });

  it("lets the minter read and write only the token Secret", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"]);
    expect(r["ServiceAccount/devbox/devbox-github-token"]).toEqual({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: meta("devbox-github-token"),
    });
    expect(r["Role/devbox/devbox-github-token"]).toEqual({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: meta("devbox-github-token"),
      rules: [{ apiGroups: [""], resources: ["secrets"], resourceNames: ["devbox-github"], verbs: ["get", "update", "patch"] }],
    });
    expect(r["RoleBinding/devbox/devbox-github-token"]).toEqual({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: meta("devbox-github-token"),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "devbox-github-token" },
      subjects: [{ kind: "ServiceAccount", name: "devbox-github-token", namespace: "devbox" }],
    });
  });

  it("allows the minter DNS, HTTPS and the API server only", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"]);
    expect(r["NetworkPolicy/devbox/devbox-github-token"]).toEqual({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta("devbox-github-token"),
      spec: {
        podSelector: {
          matchExpressions: [
            { key: "app.kubernetes.io/component", operator: "In", values: ["github-token", "github-token-seed"] },
          ],
        },
        policyTypes: ["Ingress", "Egress"],
        egress: [
          { ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
          { ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 6443 }] },
        ],
      },
    });
  });

  it("narrows tokens to every configured repo name", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"], [], [
      `repos=${JSON.stringify([
        { url: "https://github.com/example-org/example-repo.git", branch: "main" },
        { url: "https://github.com/example-org/other-repo.git", branch: "dev" },
        { url: "https://github.com/example-org/example-repo.git", branch: "release" },
      ])}`,
    ]);
    for (const key of ["Deployment/devbox/devbox-github-token", "Job/devbox/devbox-github-token-seed"]) {
      expect((r[key] as Doc).spec.template.spec.containers[0].env).toEqual(ENV("example-repo,other-repo"));
    }
  });

  it("leaves GITHUB_APP_REPOSITORIES empty with tokenScope installation", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"], ["integrations.githubApp.tokenScope=installation"]);
    for (const key of ["Deployment/devbox/devbox-github-token", "Job/devbox/devbox-github-token-seed"]) {
      expect((r[key] as Doc).spec.template.spec.containers[0].env).toEqual(ENV(""));
    }
  });

  it("narrows tokens unless tokenScope is installation", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"], [], ["integrations.githubApp.tokenScope=null"]);
    expect((r["Deployment/devbox/devbox-github-token"] as Doc).spec.template.spec.containers[0].env).toEqual(ENV("widgets"));
  });

  it("names the user's key Secret", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"], ["secrets.githubApp.existingSecret=example-app-key"]);
    for (const key of ["Deployment/devbox/devbox-github-token", "Job/devbox/devbox-github-token-seed"]) {
      expect((r[key] as Doc).spec.template.spec.volumes[0].secret.secretName).toBe("example-app-key");
    }
  });

  it("mounts the key file group-readable, octal 0440", async () => {
    const r = await helmTemplate([
      "-f", join(import.meta.dir, "values", "base.yaml"),
      "-f", join(import.meta.dir, "values", "github-app.yaml"),
      "--show-only", "templates/github-token.yaml",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.match(/defaultMode: .*$/gm)).toEqual(["defaultMode: 0440", "defaultMode: 0440"]);
  });

  it("mounts the key Secret only in the minter and the seed Job", async () => {
    const r = await renderWith(["base.yaml", "github-app.yaml"]);
    const mounting = podSpecs(r)
      .filter(([, spec]) => (spec.volumes ?? []).some((v: Doc) => v.secret?.secretName === "devbox-github-app"))
      .map(([key]) => key)
      .sort();
    expect(mounting).toEqual(["Deployment/devbox/devbox-github-token", "Job/devbox/devbox-github-token-seed"]);
  });

  it("renders all of it with the App on and devbox tokens", async () => {
    expect(minterDocs(await renderWith(["base.yaml", "github-app.yaml"]))).toEqual(MINTER_KINDS);
  });

  it("renders none of it with external tokens", async () => {
    expect(minterDocs(await renderWith(["base.yaml", "github-app-external.yaml"]))).toEqual([]);
  });

  it("renders none of it with the App off", async () => {
    expect(minterDocs(await renderWith(["base.yaml", "github-app.yaml"], ["integrations.githubApp.enabled=false"]))).toEqual([]);
    expect(minterDocs(await renderWith(["base.yaml"]))).toEqual([]);
  });

  it("renders none of it for an App registered but not yet installed", async () => {
    const r = await renderWith(["base.yaml"], [], [`integrations.githubApp=${JSON.stringify(REGISTERED_ONLY)}`]);
    expect(minterDocs(r)).toEqual([]);
    expect(integrationEnv(r)).toEqual({});
  });
});

describe("GitHub token mounts", () => {
  const tokenVolume = (r: Rendered, deployment: string, volume: string) =>
    (r[`Deployment/devbox/${deployment}`] as Doc).spec.template.spec.volumes.find((v: Doc) => v.name === volume);

  it.each([
    ["github-app.yaml", "devbox-github"],
    ["github-app-external.yaml", "example-github-token"],
    ["linear.yaml", "devbox-github"],
  ])("mount the whole token Secret with %s", async (file, secretName) => {
    const r = await renderWith(["base.yaml", file]);
    expect(tokenVolume(r, "devbox-control-plane", "github-token")).toEqual({ name: "github-token", secret: { secretName } });
    expect(tokenVolume(r, "devbox-iron-proxy", "github")).toEqual({ name: "github", secret: { secretName, defaultMode: MODE_0440 } });
  });
});

describe("bootstrap with the GitHub App", () => {
  const bootstrap = async (files: string[]) => {
    const r = await renderWith(["base.yaml", ...files]);
    const env: Doc[] = (r["Job/devbox/devbox-bootstrap"] as Doc).spec.template.spec.containers[0].env;
    const getRule = (r["Role/devbox/devbox-bootstrap"] as Doc).rules.find((x: Doc) => x.verbs.includes("get"));
    return { env: env.find((e) => e.name === "GITHUB_TOKEN_SECRET"), names: getRule.resourceNames };
  };

  it("creates an empty devbox-github with the App on and devbox tokens", async () => {
    expect(await bootstrap(["github-app.yaml"])).toEqual({
      env: { name: "GITHUB_TOKEN_SECRET", value: "devbox-github" },
      names: ["devbox-opensandbox", "devbox-postgres", "devbox-iron-proxy-ca", "devbox-github"],
    });
  });

  it.each([[[]], [["github-app-external.yaml"]]])("leaves the token Secret alone with %j", async (files) => {
    expect(await bootstrap(files)).toEqual({
      env: undefined,
      names: ["devbox-opensandbox", "devbox-postgres", "devbox-iron-proxy-ca"],
    });
  });
});
