import { describe, expect, it } from "bun:test";
import { parseApiConfig } from "../apiConfig";

describe("parseApiConfig", () => {
  it("defaults: off, auth on, any host, DBX-API-, 1s poll, 10 min max", () => {
    expect(parseApiConfig({})).toEqual({
      enabled: false,
      authEnabled: true,
      publicBaseUrl: "",
      allowedHosts: [],
      taskKeyPrefix: "DBX-API-",
      ssePollMs: 1000,
      sseMaxDurationMs: 600000,
    });
  });

  it("parses every value", () => {
    expect(
      parseApiConfig({
        API_ENABLED: "true",
        API_AUTH_ENABLED: "false",
        API_PUBLIC_BASE_URL: "https://api.internal.example/",
        API_ALLOWED_HOSTS: " API.internal.example , other.example ",
        API_TASK_KEY_PREFIX: "DEV-API-",
        API_SSE_POLL_MS: "250",
        API_SSE_MAX_DURATION_MS: "30000",
      }),
    ).toEqual({
      enabled: true,
      authEnabled: false,
      publicBaseUrl: "https://api.internal.example",
      allowedHosts: ["api.internal.example", "other.example"],
      taskKeyPrefix: "DEV-API-",
      ssePollMs: 250,
      sseMaxDurationMs: 30000,
    });
  });

  it("strips a port from API_ALLOWED_HOSTS entries", () => {
    expect(
      parseApiConfig({ API_ALLOWED_HOSTS: "api.internal.example:8080, Other.Example:443,plain" })
        .allowedHosts,
    ).toEqual(["api.internal.example", "other.example", "plain"]);
  });

  it("only the exact value false turns auth off", () => {
    expect(parseApiConfig({ API_AUTH_ENABLED: "FALSE" }).authEnabled).toBe(true);
    expect(parseApiConfig({ API_AUTH_ENABLED: "0" }).authEnabled).toBe(true);
  });

  it.each([
    [{ API_ENABLED: "true" }, "API_PUBLIC_BASE_URL is required when API_ENABLED=true"],
    [{ API_PUBLIC_BASE_URL: "not a url" }, "API_PUBLIC_BASE_URL must be an absolute URL"],
    [{ API_TASK_KEY_PREFIX: "dbx-" }, "API_TASK_KEY_PREFIX must match ^[A-Z][A-Z0-9-]*-$"],
    [{ API_TASK_KEY_PREFIX: "DBX" }, "API_TASK_KEY_PREFIX must match ^[A-Z][A-Z0-9-]*-$"],
    [{ API_SSE_POLL_MS: "0" }, "Env var API_SSE_POLL_MS must be a positive integer"],
    [
      { API_SSE_MAX_DURATION_MS: "abc" },
      "Env var API_SSE_MAX_DURATION_MS must be a positive integer",
    ],
  ])("rejects %j", (env, message) => {
    expect(() => parseApiConfig(env)).toThrow(message);
  });
});
