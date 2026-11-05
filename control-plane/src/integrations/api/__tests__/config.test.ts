import { describe, expect, it } from "bun:test";
import { parseApiSettings } from "../config";

const ON = { API_ENABLED: "true", API_PUBLIC_BASE_URL: "https://api.example" };

describe("parseApiSettings", () => {
  it("is off without API_ENABLED=true", () => {
    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      expect(parseApiSettings({ ...ON, API_ENABLED: value })).toBeUndefined();
    }
  });

  it("defaults the key prefix to DBX-API-", () => {
    expect(parseApiSettings(ON)).toEqual({
      publicBaseUrl: "https://api.example",
      taskKeyPrefix: "DBX-API-",
    });
    expect(parseApiSettings({ ...ON, API_TASK_KEY_PREFIX: "  " })?.taskKeyPrefix).toBe("DBX-API-");
  });

  it("trims both settings and the URL's trailing slashes", () => {
    expect(
      parseApiSettings({
        API_ENABLED: "true",
        API_PUBLIC_BASE_URL: " https://api.example/base// ",
        API_TASK_KEY_PREFIX: " DEV-API- ",
      }),
    ).toEqual({ publicBaseUrl: "https://api.example/base", taskKeyPrefix: "DEV-API-" });
  });

  it.each([
    [{ API_ENABLED: "true" }, "API_PUBLIC_BASE_URL is required when API_ENABLED=true"],
    [
      { API_ENABLED: "true", API_PUBLIC_BASE_URL: " / " },
      "API_PUBLIC_BASE_URL is required when API_ENABLED=true",
    ],
    [{ ...ON, API_PUBLIC_BASE_URL: "api.example" }, "API_PUBLIC_BASE_URL must be an absolute URL"],
    [{ ...ON, API_TASK_KEY_PREFIX: "dbx-" }, "API_TASK_KEY_PREFIX must match ^[A-Z][A-Z0-9-]*-$"],
    [{ ...ON, API_TASK_KEY_PREFIX: "DBX" }, "API_TASK_KEY_PREFIX must match ^[A-Z][A-Z0-9-]*-$"],
    [{ ...ON, API_TASK_KEY_PREFIX: "1BX-" }, "API_TASK_KEY_PREFIX must match ^[A-Z][A-Z0-9-]*-$"],
    // Checked while off too, so a bad value fails boot either way.
    [{ API_PUBLIC_BASE_URL: "not a url" }, "API_PUBLIC_BASE_URL must be an absolute URL"],
    [{ API_TASK_KEY_PREFIX: "dbx-" }, "API_TASK_KEY_PREFIX must match ^[A-Z][A-Z0-9-]*-$"],
  ])("rejects %j", (env, message) => {
    expect(() => parseApiSettings(env)).toThrow(message);
  });

  it("needs no URL while off", () => {
    expect(parseApiSettings({ API_ENABLED: "false" })).toBeUndefined();
  });
});
