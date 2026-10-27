// A bad command line or config. Its own module, without commander, so the
// control plane's scripts can import configFile.ts.
export class UsageError extends Error {
  // `command` names the subcommand, for the "--help" hint.
  constructor(
    message: string,
    readonly command?: string,
  ) {
    super(message);
  }
}
