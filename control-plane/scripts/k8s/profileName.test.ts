import { describe, expect, it } from "bun:test";
import { profileNameForContext } from "./profileName";

describe("profileNameForContext", () => {
  it.each([
    ["kind-devbox", "k8s-kind-devbox"],
    ["arn:aws:eks:eu-west-1:123456789012:cluster/dev-cluster", "k8s-dev-cluster"],
    ["arn:aws-us-gov:eks:us-gov-west-1:123456789012:cluster/Prod", "k8s-prod"],
    ["gke_my-project_europe-west1_dev", "k8s-gke-my-project-europe-west1-dev"],
    ["admin@Cluster.Local", "k8s-admin-cluster-local"],
    ["--weird--", "k8s-weird"],
    ["x".repeat(80), `k8s-${"x".repeat(59)}`],
  ])("%s → %s", (context, name) => {
    expect(profileNameForContext(context)).toBe(name);
  });
});
