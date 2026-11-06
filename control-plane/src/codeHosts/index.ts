import { githubHost } from "./github";
import { gitlabHost } from "./gitlab";
import type { CodeHostAdapter } from "./types";

export type { AssignCtx, CodeHostAdapter } from "./types";

// Every code host this build has. A new one is a file next to these and one
// entry here; its pull request URLs must not overlap another's.
export const codeHosts: readonly CodeHostAdapter[] = [githubHost, gitlabHost];
