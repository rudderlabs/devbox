import { describe, expect, it } from "bun:test";
import { LinearCheckError } from "../linear/check";
import { ConfigError } from "../up/config";
import { GithubAppSetupError } from "./githubApp";
import { PrivateKeyError } from "./githubAppKey";
import { errorMessage, isKnownError } from "./knownError";
import { PublicUrlError } from "./publicUrl";
import { SecretError } from "./secrets";

// Bun.secrets throws plain Errors with a `code`.
const bunSecretsError = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

describe("known errors", () => {
  it("a keychain error is known and points at --no-keychain", () => {
    for (const code of ["ERR_SECRETS_ACCESS_DENIED", "ERR_SECRETS_INTERNAL"]) {
      const err = bunSecretsError("Cannot autolaunch D-Bus without X11 $DISPLAY", code);
      expect(isKnownError(err)).toBe(true);
      expect(errorMessage(err)).toBe(
        "Cannot autolaunch D-Bus without X11 $DISPLAY (use --no-keychain to skip the system keychain)",
      );
    }
  });

  it("other errors keep their message; only listed classes are known", () => {
    const other = bunSecretsError("boom", "ERR_SOMETHING_ELSE");
    expect(isKnownError(other)).toBe(false);
    expect(errorMessage(other)).toBe("boom");
    expect(isKnownError(new Error("plain"))).toBe(false);
    expect(errorMessage(new SecretError("no LLM API key: set LLM_API_KEY"))).toBe(
      "no LLM API key: set LLM_API_KEY",
    );
    expect(isKnownError(new SecretError("x"))).toBe(true);
    expect(errorMessage("a string")).toBe("a string");
  });

  it("the Linear check, public URL, config and GitHub App errors are known", () => {
    expect(isKnownError(new LinearCheckError("x"))).toBe(true);
    expect(isKnownError(new PublicUrlError("x"))).toBe(true);
    expect(isKnownError(new ConfigError("x"))).toBe(true);
    expect(isKnownError(new PrivateKeyError("x"))).toBe(true);
    expect(isKnownError(new GithubAppSetupError("x"))).toBe(true);
  });
});
