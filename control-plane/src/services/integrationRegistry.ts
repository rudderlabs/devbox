import type { Context } from "hono";
import type { Env, Integration, IntegrationDefinition, TaskService } from "../integrations/types";
import { logger } from "../logger";
import type { ReplyHolds } from "./replyHolds";

// Every integration's settings by name; undefined means off. index.ts calls
// this before running migrations, so a bad setting fails boot before the
// database is touched.
export function parseIntegrationConfigs(
  definitions: readonly IntegrationDefinition[],
  env: Env,
): Map<string, unknown> {
  return new Map(definitions.map((d) => [d.name, d.parseConfig(env)]));
}

// The only record of which integrations exist. Each enabled one is created
// once, with a TaskService bound to its own name; a disabled one has no
// instance and answers its status with disabledStatus().
export class IntegrationRegistry {
  // The sources whose tasks are claimed and reconciled: every integration that
  // creates tasks, on or off, so a disabled integration's open tasks keep
  // running.
  readonly taskSources: string[];
  // The enabled integrations by name.
  readonly live: Readonly<Record<string, Integration>>;
  private readonly definitions = new Map<string, IntegrationDefinition>();

  constructor(
    definitions: readonly IntegrationDefinition[],
    configs: ReadonlyMap<string, unknown>,
    private readonly deps: {
      tasks(def: IntegrationDefinition): TaskService;
      holds: Pick<ReplyHolds, "of">;
    },
  ) {
    for (const def of definitions) {
      if (this.definitions.has(def.name)) {
        throw new Error(`integration ${def.name} is registered twice`);
      }
      this.definitions.set(def.name, def);
    }
    this.taskSources = definitions.filter((d) => d.createsTasks).map((d) => d.name);
    const live: Record<string, Integration> = {};
    for (const def of definitions) {
      const cfg = configs.get(def.name);
      if (cfg === undefined) continue;
      const tasks = deps.tasks(def);
      // Another integration's TaskService would let this one create that
      // integration's tasks and rounds.
      if (tasks.source !== def.name) {
        throw new Error(`integration ${def.name} was given the ${tasks.source} TaskService`);
      }
      live[def.name] = def.create({ tasks, log: logger }, cfg);
    }
    this.live = live;
  }

  // The enabled integrations that take webhooks.
  webhooks(): { name: string; webhook(c: Context): Promise<Response> }[] {
    return Object.entries(this.live).flatMap(([name, i]) =>
      i.webhook ? [{ name, webhook: i.webhook.bind(i) }] : [],
    );
  }

  // An integration's status body plus its held sends; undefined for a name no
  // integration has.
  status(name: string): Promise<object> | undefined {
    const def = this.definitions.get(name);
    if (!def) return undefined;
    const live = this.live[name];
    return (async () => ({
      ...(live ? await live.status() : def.disabledStatus()),
      holds: this.deps.holds.of(name),
    }))();
  }
}
