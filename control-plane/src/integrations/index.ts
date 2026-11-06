import { api } from "./api";
import { github } from "./github";
import { jira } from "./jira";
import { linear } from "./linear";
import type { IntegrationDefinition } from "./types";

// Every integration this build has. A new one is a folder next to these and
// one entry here.
export const definitions: readonly IntegrationDefinition[] = [linear, github, api, jira];
