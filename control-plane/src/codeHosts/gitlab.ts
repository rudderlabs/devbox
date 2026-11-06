import { parseMrUrl, postMrNote } from "../clients/gitlab";
import type { CodeHostAdapter } from "./types";

// Merge requests on the configured GitLab instance (GITLAB_BASE_URL); with
// none configured it owns no URL.
//
// No `assign`: nothing links a task's person to a GitLab account. Linear
// links GitHub accounts only, so a merge request gets no assignee yet.
export const gitlabHost: CodeHostAdapter = {
  name: "gitlab",

  owns: (url) => parseMrUrl(url) !== null,

  // GitLab delivers each note on its own (there is no review summary), so the
  // text asks for one note that says everything.
  onboardingBody: (botUsername, taskKey) =>
    [
      `👋 I'm **${botUsername}**. I opened this merge request from task \`${taskKey}\`.`,
      "",
      `Mention \`@${botUsername}\` in a comment here or on a line of the diff and I'll act on it.`,
      "Each comment is handled on its own, so put everything into one. Without a mention I won't see it.",
    ].join("\n"),

  async comment(url, body, signal) {
    const mr = parseMrUrl(url);
    if (!mr) throw new Error("not a merge request URL on the configured GitLab instance");
    await postMrNote(mr.project, mr.mrIid, body, signal);
  },
};
