// The labels snapshot-builder.sh (deploy/helm/devbox/files) puts on every
// snapshot it makes. The control plane restores only these, and the
// installer counts only these, so a snapshot made by hand is never touched.
// The shell scripts (snapshot-builder.sh, e2e.sh) repeat it; keep them equal.
export const REPO_SNAPSHOT_SELECTOR =
  "app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder";
