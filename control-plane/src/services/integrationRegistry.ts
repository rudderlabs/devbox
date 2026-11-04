import type { Context } from "hono";
import type { Env, Integration, IntegrationDefinition, TaskService } from "../integrations/types";
import { logger } from "../logger";
import type { ReplyHolds } from "./replyHolds";
import { BoundTaskService } from "./task.service";

// Every integration's settings by name; undefined means off. index.ts calls
// this before running migrations, so a bad setting fails boot before the
// database is touched.
export function parseIntegrationConfigs(
  definitions: readonly IntegrationDefinition[],
  env: Env,
): Map<string, unknown> {
  return new Map(definitions.map((d) => [d.name, d.parseConfig(env)]));
}

// What every TaskService shares; the registry binds each to its integration.
type TaskServiceDeps = Omit<ConstructorParameters<typeof BoundTaskService>[1], "createsTasks">;

// The only record of which integrations exist. It builds one TaskService per
// integration, bound to its name and its createsTasks. Each enabled
// integration is created once with its own; a disabled one has no instance and
// answers its status with disabledStatus().
export class IntegrationRegistry {
  // The sources whose tasks are claimed and reconciled: every integration that
  // creates tasks, on or off, so a disabled integration's open tasks keep
  // running.
  readonly taskSources: string[];
  // The enabled integrations by name.
  readonly live: Readonly<Record<string, Integration>>;
  private readonly definitions = new Map<string, IntegrationDefinition>();
  private readonly taskServices = new Map<string, TaskService>();
  private readonly holds: Pick<ReplyHolds, "of">;

  constructor(
    definitions: readonly IntegrationDefinition[],
    configs: ReadonlyMap<string, unknown>,
    deps: TaskServiceDeps & { holds: Pick<ReplyHolds, "of"> },
  ) {
    const { holds, ...shared } = deps;
    this.holds = holds;
    for (const def of definitions) {
      if (this.definitions.has(def.name)) {
        throw new Error(`integration ${def.name} is registered twice`);
      }
      this.definitions.set(def.name, def);
      this.taskServices.set(
        def.name,
        new BoundTaskService(def.name, { ...shared, createsTasks: def.createsTasks }),
      );
    }
    this.taskSources = definitions.filter((d) => d.createsTasks).map((d) => d.name);
    const live: Record<string, Integration> = {};
    for (const def of definitions) {
      const cfg = configs.get(def.name);
      if (cfg === undefined) continue;
      live[def.name] = def.create({ tasks: this.tasks(def.name), log: logger }, cfg);
    }
    this.live = live;
  }

  // The TaskService bound to `name`: the one its integration was given.
  tasks(name: string): TaskService {
    const tasks = this.taskServices.get(name);
    if (!tasks) throw new Error(`no integration is named ${name}`);
    return tasks;
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
      holds: this.holds.of(name),
    }))();
  }
}
