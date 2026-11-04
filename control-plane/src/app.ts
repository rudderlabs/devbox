import { Hono } from "hono";
import { githubTokenState } from "./clients/github";
import { realClock } from "./clock";
import { config } from "./config";
import { ApiController } from "./controllers/api.controller";
import { HealthController } from "./controllers/health.controller";
import { db } from "./db";
import { taskSource } from "./db/schema";
import { ApiIntegration } from "./integrations/api";
import { GithubIntegration } from "./integrations/github";
import { GithubStatusService } from "./integrations/github/status";
import { GitHubWebhookController } from "./integrations/github/webhook";
import { LinearIntegration } from "./integrations/linear";
import { AgentSessionService } from "./integrations/linear/agentSession";
import { LinearStatusService } from "./integrations/linear/status";
import { LinearTokenProvider } from "./integrations/linear/tokenProvider";
import { LinearWebhookController } from "./integrations/linear/webhook";
import type { Integration, IntegrationName } from "./integrations/types";
import { logger } from "./logger";
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

export function createApp(): AppBundle {
  // Always built, but inert when Linear is off: callers only use it for Linear
  // tasks, and without credentials it throws "Linear is not configured" rather
  // than calling Linear. The status service gets it only when Linear is on.
  const linearTokenProvider = new LinearTokenProvider({
    creds: config.linear && {
      clientId: config.linear.clientId,
      clientSecret: config.linear.clientSecret,
    },
    log: logger,
  });
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

  const linearStatus = new LinearStatusService(
    config.linear ? linearTokenProvider : undefined,
    logger,
  );

  // The only way tasks and rounds are created, one service per source. A
  // restart's preempted sandbox is killed in the hooks' tracked detached set.
  // The hooks need the integrations, built below from these services; that is
  // safe because no task is assigned or restarted before requests are served.
  const detach: Pick<IntegrationHooks, "detach"> = {
    detach: (...args) => hooks.detach(...args),
  };
  const bound = (source: IntegrationName) =>
    new BoundTaskService(source, taskRepository, inboxRepository, sandboxManager, detach);
  const tasks = { linear: bound("linear"), github: bound("github"), api: bound("api") };

  // A webhook controller needs only its source's TaskService, so it is built
  // first and handed to its integration, only when enabled.
  const linearController = config.linear
    ? new LinearWebhookController(
        new AgentSessionService(tasks.linear, linearTokenProvider),
        (at) => linearStatus.recordWebhook(at),
      )
    : undefined;
  const githubController = config.github.webhooks
    ? new GitHubWebhookController(tasks.github, config.github.webhooks)
    : undefined;

  const githubStatus = new GithubStatusService(githubTokenState, {
    enabled: config.github.webhooks !== undefined,
    ciResults: config.github.ciResultEnabled,
    lastWebhookAt: (): string | null => githubController?.lastWebhookAt() ?? null,
  });

  const integrations = createIntegrations(config, linearTokenProvider, linearStatus, githubStatus, {
    linear: linearController,
    github: githubController,
  });
  // The registered integrations that create tasks (github creates none). Only
  // these sources are claimed and reconciled, so an older image never works a
  // task whose source it doesn't know.
  const taskSources = taskSource.enumValues.filter((s) => s in integrations);
  // Sends held because they failed before anything went out; each
  // integration's status reports its own.
  const replyHolds = new ReplyHolds();
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
    taskSources,
    hooks,
  );

  const healthController = new HealthController(db);

  const app = new Hono();
  app.route("/", createHealthRoutes(healthController));
  app.route("/", createWebhookRoutes(Object.values(integrations)));

  // /api only mounts when explicitly enabled: a CP deployed before the
  // internal ingress exists must expose nothing.
  let stopApiStreams = () => {};
  if (config.api.enabled) {
    const apiTaskService = new ApiTaskService(apiTaskRepository, tasks.api, taskEventRepository, {
      publicBaseUrl: config.api.publicBaseUrl,
      taskKeyPrefix: config.api.taskKeyPrefix,
      now: () => new Date(),
    });
    const apiController = new ApiController(apiTaskService, {
      authEnabled: config.api.authEnabled,
      ssePollMs: config.api.ssePollMs,
      sseMaxDurationMs: config.api.sseMaxDurationMs,
      clock: realClock,
    });
    app.route(
      "/",
      createApiRoutes(apiController, new ApiAuthService(apiTokenRepository), {
        authEnabled: config.api.authEnabled,
        allowedHosts: config.api.allowedHosts,
        integrations: statusesWithHolds(integrations, replyHolds),
      }),
    );
    stopApiStreams = () => apiController.closeStreams();
  }

  return { app, taskProcessor, stopApiStreams };
}

// The registry. Every outbound message goes through
// integrations[round.source].deliver, and core skips a disabled
// integration's webhook, sends and hooks.
export function createIntegrations(
  cfg: { linear?: unknown; api: { enabled: boolean }; github: { webhooks?: unknown } },
  linearTokenProvider: Pick<LinearTokenProvider, "getAuthorizedLinearClient">,
  linearStatus: Pick<LinearStatusService, "status">,
  githubStatus: Pick<GithubStatusService, "status">,
  controllers: {
    linear?: Pick<LinearWebhookController, "handleWebhook">;
    github?: Pick<GitHubWebhookController, "handleWebhook">;
  },
) {
  return {
    linear: new LinearIntegration(
      linearTokenProvider,
      cfg.linear !== undefined,
      linearStatus,
      controllers.linear,
    ),
    api: new ApiIntegration(cfg.api.enabled),
    // GitHub rounds come only from its webhooks.
    github: new GithubIntegration(
      cfg.github.webhooks !== undefined,
      githubStatus,
      controllers.github,
    ),
  } satisfies Record<IntegrationName, Integration>;
}

// Each integration's own status body, plus its held sends.
export function statusesWithHolds(
  integrations: ReturnType<typeof createIntegrations>,
  replyHolds: Pick<ReplyHolds, "of">,
): Record<IntegrationName, Pick<Integration, "status">> {
  return Object.fromEntries(
    Object.values(integrations).map((i) => [
      i.name,
      { status: async () => ({ ...(await i.status()), holds: replyHolds.of(i.name) }) },
    ]),
  ) as Record<IntegrationName, Pick<Integration, "status">>;
}
