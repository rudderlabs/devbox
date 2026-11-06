import { describe, expect, it } from "bun:test";
import {
  parseGitlabBaseUrl,
  parseSandboxGitIdentity,
  parseSandboxGitlabGitIdentity,
  parseSandboxRuntimeConfig,
} from "../sandboxConfig";

describe("parseSandboxRuntimeConfig", () => {
  it("defaults to the docker runtime and the local harness image", () => {
    expect(parseSandboxRuntimeConfig({})).toEqual({
      sandboxRuntime: "docker",
      baseImage: "devbox-dev:local",
      sandboxResourceMemory: "8Gi",
      pvcNamespace: "devbox-sandboxes",
      pvcStorageClass: "",
    });
  });

  it("parses every value on k8s", () => {
    expect(
      parseSandboxRuntimeConfig({
        SANDBOX_RUNTIME: "k8s",
        SANDBOX_IMAGE: "ghcr.io/acme/harness:1.2.3",
        SANDBOX_RESOURCE_MEMORY: "16Gi",
        PVC_NAMESPACE: "sandboxes",
        PVC_STORAGE_CLASS: "gp3",
      }),
    ).toEqual({
      sandboxRuntime: "k8s",
      baseImage: "ghcr.io/acme/harness:1.2.3",
      sandboxResourceMemory: "16Gi",
      pvcNamespace: "sandboxes",
      pvcStorageClass: "gp3",
    });
  });

  it("requires PVC_STORAGE_CLASS on k8s", () => {
    const error = new Error("PVC_STORAGE_CLASS is required when SANDBOX_RUNTIME=k8s");
    expect(() => parseSandboxRuntimeConfig({ SANDBOX_RUNTIME: "k8s" })).toThrow(error);
    expect(() =>
      parseSandboxRuntimeConfig({ SANDBOX_RUNTIME: "k8s", PVC_STORAGE_CLASS: "  " }),
    ).toThrow(error);
  });

  it("treats empty values as unset", () => {
    expect(
      parseSandboxRuntimeConfig({ SANDBOX_RUNTIME: "", SANDBOX_IMAGE: "", PVC_NAMESPACE: "" }),
    ).toEqual(parseSandboxRuntimeConfig({}));
  });

  it("rejects an unknown runtime", () => {
    expect(() => parseSandboxRuntimeConfig({ SANDBOX_RUNTIME: "podman" })).toThrow(
      new Error('SANDBOX_RUNTIME must be "k8s" or "docker" (got "podman")'),
    );
  });
});

describe("parseSandboxGitIdentity", () => {
  it("is undefined when neither is set", () => {
    expect(parseSandboxGitIdentity({ SANDBOX_GIT_NAME: " " })).toBeUndefined();
  });

  it("reads both", () => {
    expect(
      parseSandboxGitIdentity({ SANDBOX_GIT_NAME: " Ada ", SANDBOX_GIT_EMAIL: "ada@example.com" }),
    ).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("requires both together", () => {
    expect(() => parseSandboxGitIdentity({ SANDBOX_GIT_NAME: "Ada" })).toThrow(
      new Error("SANDBOX_GIT_NAME and SANDBOX_GIT_EMAIL must be set together"),
    );
  });
});

describe("parseGitlabBaseUrl", () => {
  it("is undefined when unset or blank", () => {
    expect(parseGitlabBaseUrl({})).toBeUndefined();
    expect(parseGitlabBaseUrl({ GITLAB_BASE_URL: "  " })).toBeUndefined();
  });

  it("normalises the URL to its origin and path, without a trailing slash", () => {
    expect(parseGitlabBaseUrl({ GITLAB_BASE_URL: "https://gitlab.example.com/" })).toBe(
      "https://gitlab.example.com",
    );
    expect(parseGitlabBaseUrl({ GITLAB_BASE_URL: "https://example.com/gitlab/" })).toBe(
      "https://example.com/gitlab",
    );
  });

  it.each([
    ["gitlab.example.com", "must be an http(s) URL"],
    ["ftp://gitlab.example.com", "must be an http(s) URL"],
    ["https://gitlab.example.com:8443", "must use the default port"],
    ["https://user:pw@gitlab.example.com", "must not have a query, fragment or credentials"],
    ["https://gitlab.example.com/?x=1", "must not have a query, fragment or credentials"],
  ])("rejects %s", (raw, message) => {
    expect(() => parseGitlabBaseUrl({ GITLAB_BASE_URL: raw })).toThrow(message);
  });
});

describe("parseSandboxGitlabGitIdentity", () => {
  it("reads both, is undefined with neither, and refuses one without the other", () => {
    expect(parseSandboxGitlabGitIdentity({})).toBeUndefined();
    expect(
      parseSandboxGitlabGitIdentity({
        SANDBOX_GITLAB_GIT_NAME: " devbox ",
        SANDBOX_GITLAB_GIT_EMAIL: "2-devbox@users.noreply.git.example.com",
      }),
    ).toEqual({ name: "devbox", email: "2-devbox@users.noreply.git.example.com" });
    expect(() => parseSandboxGitlabGitIdentity({ SANDBOX_GITLAB_GIT_NAME: "devbox" })).toThrow(
      "SANDBOX_GITLAB_GIT_NAME and SANDBOX_GITLAB_GIT_EMAIL must be set together",
    );
  });
});
