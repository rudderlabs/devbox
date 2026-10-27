import { describe, expect, it } from "bun:test";
import { KubeError } from "./run";
import { secretManifest, userSecrets } from "./secrets";

describe("userSecrets", () => {
  const tokens = { github: { token: "ghp_x" }, llm: "sk-y", integrations: {} };

  it("creates the GitHub and LLM Secrets, and no integrations one when it holds nothing", () => {
    expect(userSecrets({}, tokens)).toEqual([
      { name: "devbox-github", data: { token: "ghp_x" } },
      { name: "devbox-llm", data: { "api-key": "sk-y" } },
    ]);
  });

  it("devbox-integrations holds exactly the resolved integration secrets", () => {
    const integrations = {
      LINEAR_CLIENT_SECRET: "lcs",
      LINEAR_WEBHOOK_SECRET: "lws",
      SLACK_BOT_TOKEN: "xoxb",
      GITHUB_WEBHOOK_SECRET: "whs",
    };
    expect(userSecrets({}, { ...tokens, integrations })).toEqual([
      { name: "devbox-github", data: { token: "ghp_x" } },
      { name: "devbox-llm", data: { "api-key": "sk-y" } },
      { name: "devbox-integrations", data: integrations },
    ]);
  });

  it("the GitHub App's key Secret and a minted token with its expiry", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n";
    expect(
      userSecrets(
        {},
        {
          ...tokens,
          github: { token: "ghs_minted", expiresAt: "2026-10-19T13:00:00Z" },
          githubApp: { pem },
        },
      ),
    ).toEqual([
      {
        name: "devbox-github",
        data: { token: "ghs_minted", "expires-at": "2026-10-19T13:00:00Z" },
      },
      { name: "devbox-github-app", data: { "private-key": pem } },
      { name: "devbox-llm", data: { "api-key": "sk-y" } },
    ]);
  });

  it("no token Secret when the installer has no token to write", () => {
    expect(userSecrets({}, { ...tokens, github: undefined })).toEqual([
      { name: "devbox-llm", data: { "api-key": "sk-y" } },
    ]);
  });

  it("skips Secrets the user brings", () => {
    const values = {
      secrets: {
        github: { existingSecret: "mine" },
        llm: { existingSecret: "mine2" },
        integrations: { existingSecret: "mine3" },
        githubApp: { existingSecret: "mine4" },
      },
    };
    expect(
      userSecrets(values, {
        ...tokens,
        githubApp: { pem: "pem" },
        integrations: { SLACK_BOT_TOKEN: "xoxb" },
      }),
    ).toEqual([]);
  });

  it("refuses an empty LLM key", () => {
    expect(() => userSecrets({}, { ...tokens, llm: "" })).toThrow(
      new KubeError(
        "Kubernetes installs need a non-empty LLM API key (LLM_API_KEY): iron-proxy cannot serve an empty one",
      ),
    );
  });
});

describe("secretManifest", () => {
  it("base64-encodes values and labels the Secret as the installer's", () => {
    expect(JSON.parse(secretManifest({ name: "devbox-github", data: { token: "ghp_x" } }))).toEqual(
      {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
          name: "devbox-github",
          namespace: "devbox",
          labels: {
            "app.kubernetes.io/part-of": "devbox",
            "app.kubernetes.io/managed-by": "devbox-installer",
          },
        },
        data: { token: Buffer.from("ghp_x").toString("base64") },
      },
    );
  });
});
