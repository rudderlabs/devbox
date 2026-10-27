import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTarget, parseTarget, TargetError } from "./target";

const dir = mkdtempSync(join(tmpdir(), "devbox-target-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const F = "devbox.k8s.json";

describe("parseTarget", () => {
  it("keeps context, profile and values verbatim", () => {
    const raw = {
      context: "arn:aws:eks:eu-west-1:123:cluster/dev",
      profile: "k8s-dev",
      values: { storage: { storageClass: "gp3" }, sandbox: { maxConcurrent: 3 } },
    };
    expect(parseTarget(raw, F)).toEqual(raw);
  });

  it("needs only a context", () => {
    expect(parseTarget({ context: "kind-devbox" }, F)).toEqual({
      context: "kind-devbox",
      values: {},
    });
  });

  it("accepts integrations.linear", () => {
    const raw = {
      context: "c",
      values: {},
      integrations: { linear: { enabled: true, clientId: " client-1 " } },
    };
    expect(parseTarget(raw, F)).toEqual({
      context: "c",
      values: {},
      integrations: { linear: { enabled: true, clientId: "client-1" } },
    });
  });

  it("accepts a top-level publicUrl, validated", () => {
    expect(parseTarget({ context: "c", publicUrl: "https://hooks.example.com/" }, F)).toEqual({
      context: "c",
      publicUrl: "https://hooks.example.com",
      values: {},
    });
    expect(() => parseTarget({ context: "c", publicUrl: "http://hooks.example.com" }, F)).toThrow(
      new TargetError(
        "devbox.k8s.json: publicUrl: Webhooks need a public HTTPS URL: http://hooks.example.com uses http:, not https:",
      ),
    );
    expect(() => parseTarget({ context: "c", publicUrl: 3 }, F)).toThrow(
      new TargetError("devbox.k8s.json: publicUrl: must be a string"),
    );
  });

  it("refuses integrations.linear.publicUrl", () => {
    expect(() =>
      parseTarget(
        {
          context: "c",
          integrations: {
            linear: { enabled: true, clientId: "c1", publicUrl: "https://h.example.com" },
          },
        },
        F,
      ),
    ).toThrow(
      new TargetError(
        'devbox.k8s.json: integrations.linear: unknown key "publicUrl" (allowed: enabled, clientId); moved to the top-level publicUrl',
      ),
    );
  });

  it("accepts integrations.slack and integrations.githubApp", () => {
    const githubApp = {
      enabled: true,
      appId: 123,
      slug: "example-devbox",
      installationId: 456,
      botUserId: 789,
      tokens: "devbox",
    } as const;
    const integrations = { slack: { enabled: true, channelId: "C123" }, githubApp };
    expect(parseTarget({ context: "c", integrations }, F)).toEqual({
      context: "c",
      values: {},
      integrations: {
        slack: integrations.slack,
        githubApp: { ...githubApp, tokenScope: "repos", ciResults: true },
      },
    });
  });

  it("refuses a top-level github: trust lists are chart values", () => {
    expect(() => parseTarget({ context: "c", github: { trustedOrgs: ["acme"] } }, F)).toThrow(
      new TargetError('devbox.k8s.json: unknown key "github"; chart values go under values'),
    );
  });

  it("refuses integrations.linear with an unknown key", () => {
    expect(() =>
      parseTarget(
        {
          context: "c",
          integrations: { linear: { enabled: true, clientId: "c1", clientSecret: "x" } },
        },
        F,
      ),
    ).toThrow(
      new TargetError(
        'devbox.k8s.json: integrations.linear: unknown key "clientSecret" (allowed: enabled, clientId)',
      ),
    );
  });

  it.each([
    ["eks", "devbox.k8s.json: must be a JSON object"],
    [{}, "devbox.k8s.json: context: required, the kube context of the cluster"],
    [{ context: "" }, "devbox.k8s.json: context: required, the kube context of the cluster"],
    [
      { context: "c", storageClass: "gp3" },
      'devbox.k8s.json: unknown key "storageClass"; chart values go under values',
    ],
    [
      { context: "c", profile: "My Cluster" },
      'devbox.k8s.json: profile: use lower-case letters, digits and "-", got "My Cluster"',
    ],
    [{ context: "c", values: [] }, "devbox.k8s.json: values: must be an object of chart values"],
    [
      { context: "c", values: { repos: [] } },
      "devbox.k8s.json: values.repos: set repos in devbox.config.json",
    ],
    [
      { context: "c", values: { llm: {} } },
      "devbox.k8s.json: values.llm: set llm in devbox.config.json",
    ],
    [
      { context: "c", values: { integrations: { linear: { clientId: "c1" } } } },
      "devbox.k8s.json: values.integrations: set integrations in the target file's top-level integrations block, not under values",
    ],
  ])("rejects %j", (raw, message) => {
    expect(() => parseTarget(raw, F)).toThrow(new TargetError(message));
  });
});

describe("loadTarget", () => {
  it("reads the file and names it in errors", () => {
    const path = join(dir, "t.json");
    writeFileSync(path, JSON.stringify({ context: "kind-devbox", values: { a: 1 } }));
    expect(loadTarget(path)).toEqual({ context: "kind-devbox", values: { a: 1 } });
  });

  it("says when the file is missing", () => {
    expect(() => loadTarget(join(dir, "none.json"))).toThrow(
      new TargetError(
        `${join(dir, "none.json")} not found: the target file names the cluster to act on (docs/kubernetes/README.md#1-configure)`,
      ),
    );
  });

  it("says when the file is not JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ context: ");
    expect(() => loadTarget(path)).toThrow(new TargetError(`${path}: not valid JSON`));
  });
});
