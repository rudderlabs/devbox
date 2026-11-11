// The deployment `clickup:*` acts on: Compose without --target, the k8s
// deployment a target file describes with it. The same as Jira's, holding
// `integrations.clickup` instead. Nothing here applies anything.
import type { JiraDeployment } from "../jira/deployment";
import { loadDeployment as loadJiraDeployment } from "../jira/deployment";
import type { ClickupIntegration } from "../lib/integrations";

export type ClickupDeployment = Omit<JiraDeployment, "jira"> & {
  clickup: ClickupIntegration | undefined;
};

export function loadDeployment(opts: { target?: string; configPath?: string }): ClickupDeployment {
  const { jira: _, ...d } = loadJiraDeployment(opts);
  return { ...d, clickup: d.integrations.clickup };
}
