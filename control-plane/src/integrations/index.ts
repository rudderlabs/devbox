import { api } from "./api";
import { clickup } from "./clickup";
import { github } from "./github";
import { gitlab } from "./gitlab";
import { jira } from "./jira";
import { linear } from "./linear";
import type { IntegrationDefinition } from "./types";

// Every integration this build has. A new one is a folder next to these and
// one entry here.
export const definitions: readonly IntegrationDefinition[] = [
  linear,
  github,
  gitlab,
  api,
  jira,
  clickup,
];
