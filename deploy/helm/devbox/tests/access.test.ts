// Reaching the control plane, and the rest of the access options.
import { describe, expect, it } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHART, type Doc, renderWith } from "./render";

describe("access", () => {
  it("waits up to five minutes for the control plane to start", async () => {
    const docs = await renderWith(["base.yaml"]);
    const c = docs["Deployment/devbox/devbox-control-plane"]?.spec.template.spec.containers[0];
    expect(c.startupProbe).toEqual({ httpGet: { path: "/health", port: "http" }, periodSeconds: 5, failureThreshold: 60 });
  });

  it("has no Ingress by default", async () => {
    expect(Object.keys(await renderWith(["base.yaml"])).filter((k) => k.startsWith("Ingress/"))).toEqual([]);
  });

  const NAME = (role: string) => `Ingress/devbox/devbox-control-plane-${role}`;
  const backend = { service: { name: "devbox-control-plane", port: { number: 3000 } } };
  const ingresses = (r: Record<string, Doc>) => Object.keys(r).filter((k) => k.startsWith("Ingress/")).sort();

  it("routes only /webhook/ on the webhooks Ingress", async () => {
    const r = await renderWith(["base.yaml", "ingress-webhooks.yaml"]);
    expect(ingresses(r)).toEqual([NAME("webhooks")]);
    expect((r[NAME("webhooks")] as Doc).spec).toEqual({
      ingressClassName: "nginx",
      tls: [{ hosts: ["hooks.example.com"], secretName: "hooks-tls" }],
      rules: [{ host: "hooks.example.com", http: { paths: [{ path: "/webhook/", pathType: "Prefix", backend }] } }],
    });
  });

  it("routes / on the api Ingress", async () => {
    const r = await renderWith(["base.yaml", "ingress-api.yaml"]);
    expect(ingresses(r)).toEqual([NAME("api")]);
    expect((r[NAME("api")] as Doc).spec).toEqual({
      ingressClassName: "nginx",
      tls: [{ hosts: ["devbox.example.com"], secretName: "devbox-tls" }],
      rules: [{ host: "devbox.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend }] } }],
    });
  });

  it("renders both Ingresses with their own class, host, annotations and TLS", async () => {
    const r = await renderWith(["base.yaml", "ingress-both.yaml"]);
    expect(ingresses(r)).toEqual([NAME("api"), NAME("webhooks")]);
    const w = r[NAME("webhooks")] as Doc;
    expect(w.metadata.name).toBe("devbox-control-plane-webhooks");
    expect(w.metadata.annotations).toEqual({ "nginx.ingress.kubernetes.io/limit-rps": "10" });
    expect(w.spec).toEqual({
      ingressClassName: "public-nginx",
      rules: [{ host: "hooks.example.com", http: { paths: [{ path: "/webhook/", pathType: "Prefix", backend }] } }],
    });
    const a = r[NAME("api")] as Doc;
    expect(a.metadata.name).toBe("devbox-control-plane-api");
    expect(a.metadata.annotations).toEqual({ "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600" });
    expect(a.spec).toEqual({
      ingressClassName: "internal-nginx",
      tls: [{ hosts: ["devbox.internal.example.com"], secretName: "devbox-tls" }],
      rules: [{ host: "devbox.internal.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend }] } }],
    });
  });

  it("renders both Ingresses on one host", async () => {
    const r = await renderWith(["base.yaml", "ingress-both.yaml"], ["ingress.webhooks.host=devbox.internal.example.com"]);
    expect(ingresses(r)).toEqual([NAME("api"), NAME("webhooks")]);
  });

  async function baseUrl(files: string[], set: string[] = []): Promise<string> {
    const r = await renderWith(["base.yaml", ...files], set);
    const env = (r["Deployment/devbox/devbox-control-plane"] as Doc).spec.template.spec.containers[0].env;
    return env.find((e: Doc) => e.name === "API_PUBLIC_BASE_URL").value;
  }

  it("keeps localhost in task links when only webhooks are exposed", async () => {
    expect(await baseUrl(["ingress-webhooks.yaml"])).toBe("http://localhost:3000");
  });
  it("uses the api Ingress URL in task links", async () => {
    expect(await baseUrl(["ingress-api.yaml"])).toBe("https://devbox.example.com");
  });
  it("uses the api Ingress URL when both are enabled", async () => {
    expect(await baseUrl(["ingress-both.yaml"])).toBe("https://devbox.internal.example.com");
  });
  it("uses http in task links when the api Ingress has no TLS", async () => {
    expect(await baseUrl(["ingress-api.yaml"], ["ingress.api.tls=null"])).toBe("http://devbox.example.com");
  });
  it("lets controlPlane.publicBaseUrl override the api Ingress URL", async () => {
    expect(await baseUrl(["ingress-api.yaml"], ["controlPlane.publicBaseUrl=https://links.example.com"])).toBe(
      "https://links.example.com",
    );
  });

  it("adds PDBs only with more than one replica", async () => {
    const pdbs = (r: Record<string, Doc>) => Object.keys(r).filter((k) => k.startsWith("PodDisruptionBudget/")).sort();
    expect(pdbs(await renderWith(["base.yaml"]))).toEqual([]);
    expect(pdbs(await renderWith(["base.yaml", "replicas.yaml"]))).toEqual([
      "PodDisruptionBudget/devbox/devbox-control-plane",
      "PodDisruptionBudget/devbox/devbox-iron-proxy",
    ]);
  });

  it("renders extra manifests through tpl", async () => {
    const r = await renderWith(["base.yaml"], [], [
      `extraManifests=${JSON.stringify([{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "extra", namespace: "{{ .Release.Namespace }}" }, data: { a: "b" } }])}`,
    ]);
    expect(r["ConfigMap/devbox/extra"]).toEqual({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "extra", namespace: "devbox" },
      data: { a: "b" },
    });
  });

  // `helm install --dry-run` needs a cluster, so render NOTES.txt as a template in a chart copy.
  // helm parses every non-NOTES template as YAML, so the copy wraps the notes in a ConfigMap.
  async function renderNotes(valuesFile: string, set: string[] = []): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "devbox-notes-"));
    try {
      const copy = join(dir, "chart");
      await cp(CHART, copy, { recursive: true });
      const notes = await Bun.file(join(copy, "templates", "NOTES.txt")).text();
      await rm(join(copy, "templates", "NOTES.txt"));
      await Bun.write(join(copy, "templates", "_notes.tpl"), `{{- define "under-test.notes" -}}\n${notes}\n{{- end }}\n`);
      await Bun.write(
        join(copy, "templates", "notes-under-test.yaml"),
        'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: notes }\ndata:\n  notes: |\n{{ include "under-test.notes" . | indent 4 }}\n',
      );
      const proc = Bun.spawn(
        [process.env.HELM_BIN ?? "helm", "template", "devbox", copy, "-n", "devbox",
          "-f", join(import.meta.dir, "values", "base.yaml"),
          "-f", join(import.meta.dir, "values", valuesFile),
          ...set.flatMap((x) => ["--set", x]),
          "--show-only", "templates/notes-under-test.yaml"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("warns in NOTES per Ingress without TLS", async () => {
    const notes = await renderNotes("ingress-both.yaml");
    expect(notes).toContain("WARNING: the webhooks Ingress has no TLS");
    expect(notes).not.toContain("WARNING: the api Ingress has no TLS");
  });
  it("warns in NOTES for the api Ingress when its TLS is removed", async () => {
    expect(await renderNotes("ingress-api.yaml", ["ingress.api.tls=null"])).toContain("WARNING: the api Ingress has no TLS");
  });
  it("does not warn in NOTES when every Ingress has TLS", async () => {
    expect(await renderNotes("ingress-api.yaml")).not.toContain("has no TLS");
  });
  it("lists each Ingress with its role in NOTES", async () => {
    const notes = await renderNotes("ingress-both.yaml");
    expect(notes).toContain("webhooks: http://hooks.example.com");
    expect(notes).toContain("API and CLI: https://devbox.internal.example.com");
  });
  it("offers the api URL for the CLI profile in NOTES, else the port-forward", async () => {
    const api = await renderNotes("ingress-api.yaml");
    expect(api).toContain("--url https://devbox.example.com");
    expect(api).not.toContain("port-forward");
    expect(api).not.toContain("k8s:connect");
    const hooks = await renderNotes("ingress-webhooks.yaml");
    expect(hooks).toContain("--url http://localhost:3000");
    expect(hooks).toContain("port-forward svc/devbox-control-plane 3000:3000");
    expect(hooks).not.toContain("--url https://hooks.example.com");
    expect(hooks).toContain("k8s:connect");
  });
  it("prints the publicBaseUrl for the api Ingress when TLS is terminated in front", async () => {
    const notes = await renderNotes("ingress-api.yaml", [
      "ingress.api.tls=null",
      "controlPlane.publicBaseUrl=https://devbox.example.com",
    ]);
    expect(notes).toContain("API and CLI: https://devbox.example.com");
    expect(notes).toContain("--url https://devbox.example.com");
  });
});

describe("LLM env", () => {
  it("renders global and all stage overrides exactly once, with extraEnv winning duplicates", async () => {
    const r = await renderWith(["base.yaml", "llm-stages.yaml"]);
    const env: Doc[] = (r["Deployment/devbox/devbox-control-plane"] as Doc).spec.template.spec.containers[0].env;
    const llmNames = new Set([
      "HARNESS_MODEL",
      "HARNESS_REASONING_EFFORT",
      "HARNESS_ORIENTATION_MODEL",
      "HARNESS_ORIENTATION_REASONING_EFFORT",
      "HARNESS_PLANNING_MODEL",
      "HARNESS_PLANNING_REASONING_EFFORT",
      "HARNESS_PLAN_REVIEW_MODEL",
      "HARNESS_PLAN_REVIEW_REASONING_EFFORT",
      "HARNESS_IMPLEMENTATION_MODEL",
      "HARNESS_IMPLEMENTATION_REASONING_EFFORT",
      "HARNESS_DISTILLATION_MODEL",
      "HARNESS_DISTILLATION_REASONING_EFFORT",
      "HARNESS_REVIEW_MODEL",
      "HARNESS_REVIEW_REASONING_EFFORT",
      "HARNESS_FOLLOWUP_MODEL",
      "HARNESS_FOLLOWUP_REASONING_EFFORT",
    ]);
    const entries = env.filter((e) => llmNames.has(e.name));

    expect(entries).toEqual([
      { name: "HARNESS_MODEL", value: "gpt-test" },
      { name: "HARNESS_REASONING_EFFORT", value: "medium" },
      { name: "HARNESS_ORIENTATION_MODEL", value: "gpt-orientation" },
      { name: "HARNESS_ORIENTATION_REASONING_EFFORT", value: "low" },
      { name: "HARNESS_PLANNING_REASONING_EFFORT", value: "high" },
      { name: "HARNESS_PLAN_REVIEW_MODEL", value: "gpt-plan-review" },
      { name: "HARNESS_PLAN_REVIEW_REASONING_EFFORT", value: "minimal" },
      { name: "HARNESS_IMPLEMENTATION_MODEL", value: "gpt-implementation" },
      { name: "HARNESS_IMPLEMENTATION_REASONING_EFFORT", value: "xhigh" },
      { name: "HARNESS_DISTILLATION_MODEL", value: "gpt-distillation" },
      { name: "HARNESS_DISTILLATION_REASONING_EFFORT", value: "medium" },
      { name: "HARNESS_REVIEW_MODEL", value: "gpt-review" },
      { name: "HARNESS_REVIEW_REASONING_EFFORT", value: "high" },
      { name: "HARNESS_FOLLOWUP_MODEL", value: "gpt-followup" },
      { name: "HARNESS_FOLLOWUP_REASONING_EFFORT", value: "none" },
      { name: "HARNESS_PLANNING_MODEL", value: "extra-env-planning" },
    ]);
    expect(entries.filter((e) => e.name === "HARNESS_PLANNING_MODEL")).toHaveLength(1);
  });
});

describe("integration env", () => {
  const INTEGRATION = /^(LINEAR_|SLACK_|GITHUB_(WEBHOOKS_ENABLED|BOT_|TRUSTED_|CI_RESULT_ENABLED))/;

  // The integration env of the control plane container, as a name -> value map.
  async function envOf(files: string[], set: string[] = [], setJson: string[] = []): Promise<Record<string, string>> {
    const r = await renderWith(["base.yaml", ...files], set, setJson);
    const env: Doc[] = (r["Deployment/devbox/devbox-control-plane"] as Doc).spec.template.spec.containers[0].env;
    return Object.fromEntries(env.filter((e) => INTEGRATION.test(e.name)).map((e) => [e.name, e.value]));
  }

  it("linear on renders LINEAR_ENABLED and LINEAR_CLIENT_ID", async () => {
    expect(await envOf(["linear.yaml"])).toEqual({ LINEAR_ENABLED: "true", LINEAR_CLIENT_ID: "lin-client-id" });
  });

  it("no LINEAR_* env with enabled false", async () => {
    // A setting renders whenever it is set; only the switch is absent.
    expect(await envOf(["linear.yaml"], ["integrations.linear.enabled=false"])).toEqual({
      LINEAR_CLIENT_ID: "lin-client-id",
    });
  });

  it("renders as off with a null integrations.linear block", async () => {
    expect(await envOf([], ["integrations.linear=null"])).toEqual({});
  });

  it("slack on renders SLACK_ENABLED and SLACK_CHANNEL_ID", async () => {
    expect(await envOf(["slack.yaml"])).toEqual({ SLACK_ENABLED: "true", SLACK_CHANNEL_ID: "C0123456789" });
  });

  it("the GitHub App on renders the webhook switch, bot identity and CI results", async () => {
    expect(await envOf(["github-app.yaml"])).toEqual({
      GITHUB_WEBHOOKS_ENABLED: "true",
      GITHUB_BOT_LOGIN: "example-devbox",
      GITHUB_BOT_USER_ID: "1234567",
      GITHUB_CI_RESULT_ENABLED: "true",
      GITHUB_TRUSTED_ORGS: "example-org",
      GITHUB_TRUSTED_USERS: "alice,bob",
    });
  });

  it("no CI results env with ciResults false", async () => {
    expect(await envOf(["github-app.yaml"], ["integrations.githubApp.ciResults=false"])).toEqual({
      GITHUB_WEBHOOKS_ENABLED: "true",
      GITHUB_BOT_LOGIN: "example-devbox",
      GITHUB_BOT_USER_ID: "1234567",
      GITHUB_TRUSTED_ORGS: "example-org",
      GITHUB_TRUSTED_USERS: "alice,bob",
    });
  });

  it("external tokens keep the webhook env", async () => {
    expect(await envOf(["github-app-external.yaml"])).toEqual({
      GITHUB_WEBHOOKS_ENABLED: "true",
      GITHUB_BOT_LOGIN: "example-devbox",
      GITHUB_BOT_USER_ID: "1234567",
      GITHUB_CI_RESULT_ENABLED: "true",
      GITHUB_TRUSTED_ORGS: "example-org",
    });
  });

  it("the GitHub App off renders none of its env, settings included", async () => {
    expect(await envOf(["github-app.yaml"], ["integrations.githubApp.enabled=false"])).toEqual({
      GITHUB_TRUSTED_ORGS: "example-org",
      GITHUB_TRUSTED_USERS: "alice,bob",
    });
  });

  it("trust lists render comma-joined, also with webhooks off", async () => {
    expect(
      await envOf(
        [],
        [],
        ['github.trustedOrgs=["example-org","other-org"]', 'github.trustedUsers=["alice"]'],
      ),
    ).toEqual({ GITHUB_TRUSTED_ORGS: "example-org,other-org", GITHUB_TRUSTED_USERS: "alice" });
  });

  it("defaults render none of these", async () => {
    expect(await envOf([])).toEqual({});
  });
});
