import { describe, expect, it } from "bun:test";
import { parseArgs } from "node:util";
import { checkKindArgs, INSTALL_FLAGS, installOptions, requireTarget } from "./k8s";
import { keychainFor } from "./lib/keychain";

describe("installOptions", () => {
  it("defaults to the first-install NetworkPolicy check and a 15m timeout", () => {
    expect(installOptions({})).toEqual({
      render: undefined,
      skipPushCheck: false,
      skipLlmCheck: false,
      skipLinearCheck: false,
      netpol: "auto",
      timeout: "15m",
    });
  });

  it("maps the flags", () => {
    expect(
      installOptions({
        render: "v.yaml",
        "skip-push-check": true,
        "skip-llm-check": true,
        "skip-linear-check": true,
        "netpol-check": true,
        timeout: "30m",
      }),
    ).toEqual({
      render: "v.yaml",
      skipPushCheck: true,
      skipLlmCheck: true,
      skipLinearCheck: true,
      netpol: "force",
      timeout: "30m",
    });
    expect(installOptions({ "skip-netpol-check": true }).netpol).toBe("skip");
  });

  it("refuses both NetworkPolicy flags", () => {
    expect(() => installOptions({ "skip-netpol-check": true, "netpol-check": true })).toThrow(
      "--skip-netpol-check and --netpol-check exclude each other",
    );
  });
});

describe("requireTarget", () => {
  it("requires --target", () => {
    expect(() => requireTarget({})).toThrow(
      "--target <file> is required: the file naming the cluster to act on (docs/kubernetes/README.md#1-configure)",
    );
  });
});

describe("checkKindArgs", () => {
  it("refuses --target, in either form", () => {
    const message =
      "k8s:kind takes no --target: it writes and uses devbox.kind.json (values of an existing one are kept)";
    expect(() => checkKindArgs(["--target", "devbox.eks.json"])).toThrow(message);
    expect(() => checkKindArgs(["--skip-llm-check", "--target=devbox.eks.json"])).toThrow(message);
  });

  it("accepts the install flags", () => {
    expect(() => checkKindArgs(["--skip-llm-check", "--timeout", "20m"])).not.toThrow();
  });

  it("parses --skip-linear-check", () => {
    const { values } = parseArgs({ args: ["--skip-linear-check"], options: INSTALL_FLAGS });
    expect(installOptions(values).skipLinearCheck).toBe(true);
  });

  it("--no-keychain gives the install no keychain", () => {
    const { values } = parseArgs({ args: ["--no-keychain"], options: INSTALL_FLAGS });
    expect(values).toEqual({ "no-keychain": true });
    expect(keychainFor(values["no-keychain"])).toBeUndefined();
    // Without the flag, the system keychain behind the silent-disable guard.
    const without = parseArgs({ args: [], options: INSTALL_FLAGS }).values;
    expect(keychainFor(without["no-keychain"])).toMatchObject({ disabled: false });
  });
});
