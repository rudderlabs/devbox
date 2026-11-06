import { parseMrUrl } from "../clients/gitlab";
import type { CodeHostAdapter } from "./types";

// Merge requests on the configured GitLab instance (GITLAB_BASE_URL); with
// none configured it owns no URL.
//
// No `assign`: nothing links a task's person to a GitLab account. Linear
// links GitHub accounts only, so a merge request gets no assignee yet.
export const gitlabHost: CodeHostAdapter = {
  name: "gitlab",
  owns: (url) => parseMrUrl(url) !== null,
};
