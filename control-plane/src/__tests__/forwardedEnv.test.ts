import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  FORWARDED_HARNESS_ENV_NAMES,
  HARNESS_CONFIGURATION_ENV_NAMES,
  isForwardedHarnessEnvName,
  isServiceLinkEnvName,
  MODEL_STAGES,
  pickForwardedEnv,
} from "../forwardedEnv";

describe("sandbox environment forwarding contract", () => {
  it("covers every harness configuration reader", async () => {
    // Any quoted HARNESS_* name in the harness counts as a reader, however it
    // is read. Stage names are built with f-strings; the ModelStage test
    // below covers those.
    const names = new Set<string>();
    for (const dir of ["src/harness", "scripts"]) {
      const cwd = join(import.meta.dir, "../../../harness", dir);
      for await (const file of new Bun.Glob("**/*.py").scan({ cwd, absolute: true })) {
        const source = await Bun.file(file).text();
        for (const match of source.matchAll(/["'](HARNESS_[A-Z][A-Z0-9_]+)["']/g)) {
          if (match[1] !== undefined) names.add(match[1]);
        }
      }
    }
    // A scan that finds nothing would pass vacuously.
    expect(names.has("HARNESS_LLM_PROVIDER")).toBe(true);
    const contractNames = new Set<string>(HARNESS_CONFIGURATION_ENV_NAMES);
    expect([...names].filter((name) => !contractNames.has(name))).toEqual([]);
  });

  it("matches the harness ModelStage enum", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../../harness/src/harness/deepagents/model.py"),
    ).text();
    const enumBlock = source.match(/class ModelStage\(StrEnum\):(?<body>[\s\S]*?)\n\n@dataclass/)
      ?.groups?.body;
    expect(enumBlock).toBeDefined();
    const pythonStages: string[] = [];
    for (const match of (enumBlock ?? "").matchAll(/^\s+([A-Z][A-Z0-9_]*) = "\1"$/gm)) {
      if (match[1] !== undefined) pythonStages.push(match[1]);
    }
    const modelStages: string[] = [...MODEL_STAGES];
    expect(pythonStages).toEqual(modelStages);
  });

  it("forwards exact names and the known stage model families", () => {
    const env: Record<string, string> = Object.fromEntries(
      FORWARDED_HARNESS_ENV_NAMES.map((name) => [name, name]),
    );
    for (const stage of MODEL_STAGES) {
      env[`HARNESS_${stage}_MODEL`] = `${stage}-model`;
      env[`HARNESS_${stage}_REASONING_EFFORT`] = "high";
    }
    expect(pickForwardedEnv(env)).toEqual(env);
  });

  it("drops undefined values and every name outside the contract", () => {
    expect(
      pickForwardedEnv({
        HARNESS_MODEL: undefined,
        HARNESS_MODEL_EXTRA: "not-a-setting",
        HARNESS_UNKNOWN_MODEL: "not-a-stage",
        SANDBOX_IMAGE: "control-plane-setting",
        HARNESS_EXP_UNKNOWN: "not-allowlisted",
        HARNESS_TRUSTED_ORGS: "must-be-derived",
        DEVBOX_MODEL: "legacy",
        DEVBOX_CLI_TOKEN: "cli-token",
        GITHUB_TOKEN: "real",
        LLM_API_KEY: "real",
        DATABASE_URL: "postgres://devbox:devbox@localhost:5432/devbox",
      }),
    ).toEqual({});
  });

  it("cannot allow a name Kubernetes may create for a Service", () => {
    const generatedNames = MODEL_STAGES.flatMap((stage) => [
      `HARNESS_${stage}_MODEL`,
      `HARNESS_${stage}_REASONING_EFFORT`,
    ]);
    for (const name of [...FORWARDED_HARNESS_ENV_NAMES, ...generatedNames]) {
      expect(isForwardedHarnessEnvName(name)).toBe(true);
      expect(isServiceLinkEnvName(name)).toBe(false);
    }
  });

  it.each([
    "DEVBOX_POSTGRES_PORT",
    "DEVBOX_CONTROL_PLANE_SERVICE_HOST",
    "DEVBOX_CONTROL_PLANE_SERVICE_PORT",
    "DEVBOX_CONTROL_PLANE_SERVICE_PORT_HTTP",
    "DEVBOX_IRON_PROXY_PORT_53_UDP",
    "DEVBOX_IRON_PROXY_PORT_53_UDP_ADDR",
    "DEVBOX_IRON_PROXY_PORT_53_UDP_PORT",
    "DEVBOX_IRON_PROXY_PORT_53_UDP_PROTO",
    "SANDBOX_LLM_PORT_443_TCP",
  ])("recognizes Kubernetes Service-link name %s", (name) => {
    expect(isServiceLinkEnvName(name)).toBe(true);
  });
});
