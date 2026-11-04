import { Hono } from "hono";
import { realClock } from "./clock";
import { config } from "./config";
import { ApiController } from "./controllers/api.controller";
import { HealthController } from "./controllers/health.controller";
import { db } from "./db";
import type { Task } from "./db/schema";
import { definitions } from "./integrations";
import { api } from "./integrations/api";
import type { IntegrationDefinition } from "./integrations/types";
import { apiTaskRepository } from "./repositories/apiTask.repository";
import { apiTokenRepository } from "./repositories/apiToken.repository";
import { inboxRepository } from "./repositories/inbox.repository";
import { taskRepository } from "./repositories/task.repository";
import { taskEventRepository } from "./repositories/taskEvent.repository";
import { createApiRoutes } from "./routes/api";
import { createHealthRoutes } from "./routes/health";
import { createWebhookRoutes } from "./routes/webhook";
import { ApiAuthService } from "./services/apiAuth.service";
import { ApiTaskService } from "./services/apiTask.service";
import { EventDispatcher } from "./services/eventDispatcher";
import { InboxService } from "./services/inbox.service";
import { IntegrationHooks } from "./services/integrationHooks";
import { IntegrationRegistry } from "./services/integrationRegistry";
import { ReplyHolds } from "./services/replyHolds";
import { SandboxManager } from "./services/sandboxManager.service";
import { SlackNotifierService } from "./services/slackNotifier.service";
import { BoundTaskService } from "./services/task.service";
import { TaskProcessorService } from "./services/taskProcessor.service";

export type AppBundle = {
  app: Hono;
  taskProcessor: TaskProcessorService;
  stopApiStreams: () => void;
};

// Trust lists are forwarded to the sandbox only when configured.
function joinIfAny(list: string[]): string | undefined {
  return list.length > 0 ? list.join(",") : undefined;
}

// integrationConfigs: each integration's settings, parsed by index.ts before
// migrations run (parseIntegrationConfigs).
export function createApp(integrationConfigs: ReadonlyMap<string, unknown>): AppBundle {
  const sandboxManager = new SandboxManager({
    domain: config.opensandbox.domain,
    apiKey: config.opensandbox.apiKey,
    baseImage: config.opensandbox.baseImage,
    resourceCpu: config.opensandbox.sandboxResourceCpu,
    resourceMemory: config.opensandbox.sandboxResourceMemory,
    timeoutSeconds: config.opensandbox.timeoutSeconds,
    reposMountPath: config.opensandbox.reposMountPath,
    requestTimeoutSeconds: config.opensandbox.requestTimeoutSeconds,
    readyTimeoutSeconds: config.opensandbox.readyTimeoutSeconds,
    reconcileFilesTimeoutMs: config.opensandbox.reconcileFilesTimeoutMs,
    gitIdentity: config.opensandbox.gitIdentity,
    sandboxRuntime: config.opensandbox.sandboxRuntime,
    reposBaseVolume: config.opensandbox.reposBaseVolume,
    snapshotNamePrefix: config.opensandbox.snapshotNamePrefix,
    pvcNamespace: config.opensandbox.pvcNamespace,
    pvcStorageClass: config.opensandbox.pvcStorageClass,
    pvcStorageSize: config.opensandbox.pvcStorageSize,
    forwardedEnv: config.opensandbox.forwardedEnv,
    trustedOrgs: joinIfAny(config.github.trustedOrgs),
    trustedUsers: joinIfAny(config.github.trustedUsers),
  });

  // The only way tasks and rounds are created, one service per source. A
  // restart's preempted sandbox is killed in the hooks' tracked detached set.
  // The hooks need the integrations, which the registry builds from these
  // services; that is safe because no task is assigned or restarted before
  // requests are served.
  const detach: Pick<IntegrationHooks, "detach"> = {
    detach: (...args) => hooks.detach(...args),
  };
  const taskService = (def: IntegrationDefinition) =>
    new BoundTaskService(def.name, taskRepository, inboxRepository, sandboxManager, detach);
  // Sends held because they failed before anything went out; each
  // integration's status reports its own.
  const replyHolds = new ReplyHolds();
  const registry = new IntegrationRegistry(definitions, integrationConfigs, {
    tasks: taskService,
    holds: replyHolds,
  });
  // The enabled integrations, for sends and hooks.
  const integrations = registry.live;
  // Integrations' lifecycle hooks; TaskProcessor.stop() drains detached ones.
  const hooks = new IntegrationHooks(integrations, inboxRepository);

  const inboxService = new InboxService(inboxRepository, sandboxManager, integrations, hooks);

  const slackNotifier = new SlackNotifierService(
    taskRepository,
    config.slack?.botToken ?? "",
    config.slack?.channel ?? "",
    hooks,
  );

  const eventDispatcher = new EventDispatcher(
    taskRepository,
    inboxRepository,
    sandboxManager,
    slackNotifier,
    integrations,
    replyHolds,
    hooks,
  );

  const taskProcessor = new TaskProcessorService(
    taskRepository,
    inboxRepository,
    sandboxManager,
    eventDispatcher,
    inboxService,
    slackNotifier,
    integrations,
    replyHolds,
    // Only these sources are claimed and reconciled, so an older image never
    // works a task whose source it doesn't know.
    registry.taskSources as Task["source"][],
    hooks,
  );

  const healthController = new HealthController(db);

  const app = new Hono();
  app.route("/", createHealthRoutes(healthController));
  app.route("/", createWebhookRoutes(registry.webhooks()));

  // /api only mounts when explicitly enabled: a CP deployed before the
  // internal ingress exists must expose nothing.
  let stopApiStreams = () => {};
  if (config.api.enabled) {
    const apiTaskService = new ApiTaskService(
      apiTaskRepository,
      taskService(api),
      taskEventRepository,
      {
        publicBaseUrl: config.api.publicBaseUrl,
        taskKeyPrefix: config.api.taskKeyPrefix,
        now: () => new Date(),
      },
    );
    const apiController = new ApiController(apiTaskService, {
      authEnabled: config.api.authEnabled,
      ssePollMs: config.api.ssePollMs,
      sseMaxDurationMs: config.api.sseMaxDurationMs,
      clock: realClock,
      taskSources: registry.taskSources,
    });
    app.route(
      "/",
      createApiRoutes(apiController, new ApiAuthService(apiTokenRepository), {
        authEnabled: config.api.authEnabled,
        allowedHosts: config.api.allowedHosts,
        status: (name) => registry.status(name),
      }),
    );
    stopApiStreams = () => apiController.closeStreams();
  }

  return { app, taskProcessor, stopApiStreams };
}
