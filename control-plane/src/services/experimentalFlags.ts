import { isServiceLinkEnvName } from "../forwardedEnv";

export const EXPERIMENTAL_FLAG_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const EXPERIMENTAL_FLAG_TOKEN_RE = /(^|\s)#devbox:exp:([A-Z][A-Z0-9_]*)(?=$|\s|[.,;:!?)}\]])/g;

function isExperimentalFlagName(flag: string): boolean {
  return EXPERIMENTAL_FLAG_NAME_RE.test(flag) && !isServiceLinkEnvName(`HARNESS_EXP_${flag}`);
}

export function parseExperimentalFlags(description: string | null | undefined): {
  flags: string[];
  strippedDescription: string | null;
} {
  if (description == null) return { flags: [], strippedDescription: null };

  const flags = new Set<string>();
  let foundToken = false;
  const stripped = description.replace(EXPERIMENTAL_FLAG_TOKEN_RE, (_match, leading, rawName) => {
    foundToken = true;
    if (isExperimentalFlagName(rawName)) {
      flags.add(rawName);
    }
    return leading;
  });

  if (!foundToken) return { flags: [], strippedDescription: description };

  return {
    flags: [...flags],
    strippedDescription: stripped,
  };
}

export function extractExperimentalFlags(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const flags = (metadata as { experimentalFlags?: unknown }).experimentalFlags;
  if (!Array.isArray(flags)) return [];

  const unique = new Set<string>();
  for (const flag of flags) {
    if (typeof flag === "string" && isExperimentalFlagName(flag)) {
      unique.add(flag);
    }
  }
  return [...unique];
}

export function experimentalEnvName(flag: string): string | null {
  if (!isExperimentalFlagName(flag)) return null;
  return `HARNESS_EXP_${flag}`;
}
