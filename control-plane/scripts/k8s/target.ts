// A deployment target: the cluster to act on, the CLI profile to
// write and the chart values for it. One file per cluster, git-ignored,
// passed to every k8s:* command with --target. devbox.config.json describes
// the setup (repos, llm); this file describes where it runs.
import { readFileSync } from "node:fs";
import { PROFILE_NAME } from "../../../cli/interface/profiles";
import { type Integrations, parseIntegrations } from "../lib/integrations";
import { parsePublicUrl } from "../lib/publicUrl";
import type { Values } from "./values";

// `integrations` is the deployment's own: k8s:install reads
// it here, never from devbox.config.json.
export type Target = {
  context: string;
  profile?: string;
  // The deployment's public URL for webhooks, validated.
  publicUrl?: string;
  values: Values;
  integrations?: Integrations;
};

export class TargetError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseTarget(raw: unknown, file: string): Target {
  const fail = (message: string): never => {
    throw new TargetError(`${file}: ${message}`);
  };
  if (!isObject(raw)) return fail("must be a JSON object");
  const { context, profile, values = {}, integrations, publicUrl, ...rest } = raw;
  const [unknown] = Object.keys(rest);
  if (unknown) return fail(`unknown key "${unknown}"; chart values go under values`);
  if (typeof context !== "string" || !context) {
    return fail("context: required, the kube context of the cluster");
  }
  if (profile !== undefined && (typeof profile !== "string" || !PROFILE_NAME.test(profile))) {
    return fail(`profile: use lower-case letters, digits and "-", got ${JSON.stringify(profile)}`);
  }
  if (!isObject(values)) return fail("values: must be an object of chart values");
  // The setup lives in devbox.config.json; the installer checks the token
  // against those repos, so a target must not swap them under it.
  for (const key of ["repos", "llm"]) {
    if (key in values) return fail(`values.${key}: set ${key} in devbox.config.json`);
  }
  // The chart's integrations values come only from the checked top-level
  // block, never set past it.
  if ("integrations" in values) {
    return fail(
      "values.integrations: set integrations in the target file's top-level integrations block, not under values",
    );
  }
  return {
    context,
    ...(profile !== undefined ? { profile } : {}),
    ...(publicUrl !== undefined ? { publicUrl: parsePublicUrl(publicUrl, "publicUrl", fail) } : {}),
    values,
    ...(integrations !== undefined
      ? { integrations: parseIntegrations(integrations, fail, { platform: "k8s" }) }
      : {}),
  };
}

export function loadTarget(path: string): Target {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TargetError(
        `${path} not found: the target file names the cluster to act on (docs/kubernetes/README.md#1-configure)`,
      );
    }
    throw new TargetError(`${path}: cannot read it (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TargetError(`${path}: not valid JSON`);
  }
  return parseTarget(raw, path);
}
