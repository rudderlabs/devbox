// The CLI profile name for a kube context is "k8s-<context>", sanitized to a
// profile name (cli/interface/profiles.ts). An EKS ARN context
// becomes its cluster name, so profiles stay readable.
import { PROFILE_NAME } from "../../../cli/interface/profiles";

const EKS_ARN = /^arn:aws[a-z-]*:eks:[^:]+:\d+:cluster\/(.+)$/;

export function profileNameForContext(context: string): string {
  const base = (EKS_ARN.exec(context)?.[1] ?? context)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `k8s-${base}`.slice(0, 63).replace(/-+$/, "");
  if (!PROFILE_NAME.test(name)) {
    throw new Error(
      `cannot make a profile name from kube context "${context}": set profile in the target file`,
    );
  }
  return name;
}
