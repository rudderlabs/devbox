// Errors that explain themselves: printed on one line, no stack.
import { TargetError } from "../k8s/target";
import { CliConfigError } from "../up/cliLogin";
import { ConfigError } from "../up/config";
import { PreflightError } from "../up/preflight";
import { PromptInterrupted } from "../up/prompt";
import { DestructiveRefused } from "./destructive";
import { GithubAppSetupError } from "./githubApp";
import { PrivateKeyError } from "./githubAppKey";
import { PublicUrlError } from "./publicUrl";
import { SecretError } from "./secrets";

const SHARED = [
  ConfigError,
  SecretError,
  PreflightError,
  PromptInterrupted,
  CliConfigError,
  TargetError,
  PublicUrlError,
  DestructiveRefused,
  PrivateKeyError,
  GithubAppSetupError,
];

const codeOf = (err: unknown): string => String((err as { code?: unknown } | null)?.code ?? "");

// An error from Bun.secrets other than "no keychain on this platform", which
// the guarded keychain swallows: a locked keychain, a refused access, a Secret
// Service that is installed but not running.
const isKeychainError = (err: unknown): boolean =>
  err instanceof Error && codeOf(err).startsWith("ERR_SECRETS_");

export function isKnownError(err: unknown, ...more: Array<new (...a: never[]) => Error>): boolean {
  return (
    [...SHARED, ...more].some((cls) => err instanceof cls) ||
    (err instanceof TypeError && /^ERR_PARSE_ARGS_/.test(codeOf(err))) ||
    isKeychainError(err)
  );
}

// The one line printed for an error.
export function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return isKeychainError(err)
    ? `${message} (use --no-keychain to skip the system keychain)`
    : message;
}
