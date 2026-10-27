// Resolves the API URL and token: flags, then env, then a profile from the
// CLI config file that `bun run up` and `bun run k8s:install` write
// (configFile.ts, profiles.ts).
import type { ClientConfig } from "../core/api";
import { type Connection, UsageError } from "./command";
import { type ProfileFile, profileOf } from "./profiles";

export type ConfigFile = { path: string; load: () => ProfileFile | undefined };

// `tokenFrom` names the file and profile when the token came from it, so a
// rejected token can be explained.
export type ResolvedConfig = {
  client: ClientConfig;
  tokenFrom?: { path: string; profile: string };
};

export function resolveConfig(
  connection: Connection,
  env: Record<string, string | undefined>,
  file: ConfigFile,
): ResolvedConfig {
  const token = connection.token || env.DEVBOX_CLI_TOKEN;
  const url = connection.url || env.DEVBOX_CLI_URL;
  // A URL from a flag or env never reads the file: its token belongs to its URL.
  if (url) return { client: { url: trim(url), ...(token ? { token } : {}) } };
  const saved = file.load();
  const names = Object.keys(saved?.profiles ?? {}).sort();
  if (!saved || names.length === 0) {
    throw new UsageError(
      `no API URL and no profile in ${file.path}: run \`bun run up\` or \`bun run k8s:install\`, or pass --url/--token`,
    );
  }
  const name = connection.profile || env.DEVBOX_CLI_PROFILE || saved.current;
  if (!name) {
    throw new UsageError(
      `no current profile in ${file.path}: run \`devbox profile use <name>\` (profiles: ${names.join(", ")})`,
    );
  }
  const profile = profileOf(saved, name);
  if (!profile) {
    throw new UsageError(`no profile "${name}" in ${file.path} (profiles: ${names.join(", ")})`);
  }
  if (token) return { client: { url: trim(profile.url), token } };
  return {
    client: { url: trim(profile.url), ...(profile.token ? { token: profile.token } : {}) },
    ...(profile.token ? { tokenFrom: { path: file.path, profile: name } } : {}),
  };
}

const trim = (url: string) => url.replace(/\/+$/, "");
