// The sandbox lockdown: the pod template the
// OpenSandbox server merges into every sandbox, and the NetworkPolicies.
import { describe, expect, it } from "bun:test";
import { type Doc, renderWith } from "./render";

const template = (r: Record<string, Doc>) =>
  Bun.YAML.parse(
    (r["ConfigMap/devbox/devbox-sandbox-template"] as Doc).data["batchsandbox-template.yaml"],
  ) as Doc;

describe("sandbox template", () => {
  it("locks sandboxes to iron-proxy with the public CA and no ServiceAccount token", async () => {
    expect(template(await renderWith(["base.yaml"]))).toEqual({
      metadata: {},
      spec: {
        replicas: 1,
        template: {
          metadata: {
            labels: { "app.kubernetes.io/part-of": "devbox", "app.kubernetes.io/component": "sandbox" },
          },
          spec: {
            restartPolicy: "Never",
            enableServiceLinks: false,
            automountServiceAccountToken: false,
            dnsPolicy: "None",
            dnsConfig: { nameservers: ["10.96.0.20"] },
            volumes: [{ name: "iron-proxy-ca", configMap: { name: "iron-proxy-ca-cert" } }],
            containers: [
              {
                name: "sandbox",
                volumeMounts: [{ name: "iron-proxy-ca", mountPath: "/run/iron-proxy", readOnly: true }],
              },
            ],
          },
        },
      },
    });
  });

  it("passes runtime class, scheduling, pull secrets and extra volumes through", async () => {
    const spec = template(await renderWith(["base.yaml", "sandbox-options.yaml"])).spec.template.spec;
    expect(spec.runtimeClassName).toBe("kata");
    expect(spec.tolerations).toEqual([{ key: "sandbox", operator: "Exists", effect: "NoSchedule" }]);
    expect(spec.nodeSelector).toEqual({ pool: "sandboxes" });
    expect(spec.imagePullSecrets).toEqual([{ name: "registry" }]);
    expect(spec.volumes).toEqual([
      { name: "iron-proxy-ca", configMap: { name: "iron-proxy-ca-cert" } },
      { name: "cache", emptyDir: {} },
    ]);
    expect(spec.containers[0].volumeMounts).toEqual([
      { name: "iron-proxy-ca", mountPath: "/run/iron-proxy", readOnly: true },
      { name: "cache", mountPath: "/cache" },
    ]);
  });

  it("passes control-plane pull secrets to every control-plane image workload", async () => {
    const expected = [{ name: "control-plane-registry" }];
    const r = await renderWith(["base.yaml", "sandbox-options.yaml", "github-app.yaml"]);
    expect((r["Deployment/devbox/devbox-control-plane"] as Doc).spec.template.spec.imagePullSecrets).toEqual(expected);
    expect((r["Job/devbox/devbox-bootstrap"] as Doc).spec.template.spec.imagePullSecrets).toEqual(expected);
    expect((r["CronJob/devbox-sandboxes/devbox-snapshot-builder"] as Doc).spec.jobTemplate.spec.template.spec.imagePullSecrets).toEqual(expected);
    expect((r["Job/devbox-sandboxes/devbox-snapshot-builder-install"] as Doc).spec.template.spec.imagePullSecrets).toEqual(expected);
    expect((r["Deployment/devbox/devbox-github-token"] as Doc).spec.template.spec.imagePullSecrets).toEqual(expected);
    expect((r["Job/devbox/devbox-github-token-seed"] as Doc).spec.template.spec.imagePullSecrets).toEqual(expected);
  });

  it("points sandbox DNS, iron-proxy's Service and its proxy_ip at the same address", async () => {
    const r = await renderWith(["base.yaml"], ["ironProxy.clusterIP=10.100.0.77"]);
    const config = Bun.YAML.parse((r["ConfigMap/devbox/devbox-iron-proxy-config"] as Doc).data["config.yaml"]) as Doc;
    expect(template(r).spec.template.spec.dnsConfig.nameservers).toEqual(["10.100.0.77"]);
    expect((r["Service/devbox/devbox-iron-proxy"] as Doc).spec.clusterIP).toBe("10.100.0.77");
    expect(config.dns.proxy_ip).toBe("10.100.0.77");
  });
});

describe("NetworkPolicies", () => {
  it("allows sandboxes only iron-proxy out and only the OpenSandbox server in", async () => {
    const r = await renderWith(["base.yaml"]);
    expect((r["NetworkPolicy/devbox-sandboxes/devbox-sandbox"] as Doc).spec).toEqual({
      podSelector: { matchLabels: { "app.kubernetes.io/part-of": "devbox", "app.kubernetes.io/component": "sandbox" } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "devbox" } },
              podSelector: { matchLabels: { "app.kubernetes.io/component": "opensandbox-server" } },
            },
          ],
        },
      ],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "devbox" } },
              podSelector: { matchLabels: { "app.kubernetes.io/component": "iron-proxy" } },
            },
          ],
          // Container ports: policies apply after the Service's port mapping.
          ports: [
            { protocol: "UDP", port: 5353 },
            { protocol: "TCP", port: 5353 },
            { protocol: "TCP", port: 8080 },
            { protocol: "TCP", port: 8443 },
          ],
        },
      ],
    });
  });

  it("ships all five policies", async () => {
    const r = await renderWith(["base.yaml"]);
    expect(Object.keys(r).filter((k) => k.startsWith("NetworkPolicy/")).sort()).toEqual([
      "NetworkPolicy/devbox-sandboxes/devbox-sandbox",
      "NetworkPolicy/devbox-sandboxes/devbox-snapshot-builder",
      "NetworkPolicy/devbox/devbox-iron-proxy",
      "NetworkPolicy/devbox/devbox-opensandbox-server",
      "NetworkPolicy/devbox/devbox-postgres",
    ]);
  });
});
