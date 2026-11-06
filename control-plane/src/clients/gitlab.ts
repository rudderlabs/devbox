// Barrel for the GitLab client, split from ./gitlabApi for the same reason as
// ./github: service and controller tests mock.module this module, and the
// client's own unit test imports the implementation directly.
export * from "./gitlabApi";
