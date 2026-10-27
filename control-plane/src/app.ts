import { Hono } from "hono";
import { githubTokenState } from "./clients/github";
import { realClock } from "./clock";
import { config } from "./config";
import { ApiController } from "./controllers/api.controller";
import { GitHubWebhookController } from "./controllers/githubWebhook.controller";
import { HealthController } from "./controllers/health.controller";
import { LinearWebhookController } from "./controllers/linearWebhook.controller";
import { db } from "./db";
import { logger } from "./logger";
import { apiTaskRepository } from "./repositories/apiTask.repository";
import { apiTokenRepository } from "./repositories/apiToken.repository";
import { inboxRepository } from "./repositories/inbox.repository";
import { taskRepository } from "./repositories/task.repository";
import { taskEventRepository } from "./repositories/taskEvent.repository";
import { createApiRoutes } from "./routes/api";
import { createHealthRoutes } from "./routes/health";
import { createWebhookRoutes } from "./routes/webhook";
import { AgentSessionService } from "./services/agentSession.service";
import { ApiAuthService } from "./services/apiAuth.service";
import { ApiTaskService } from "./services/apiTask.service";
import { EventDispatcher } from "./services/eventDispatcher";
import { GithubStatusService } from "./services/githubStatus.service";
import { InboxService } from "./services/inbox.service";
import { LinearStatusService } from "./services/linearStatus.service";
import { LinearTokenProvider } from "./services/linearTokenProvider";
import { SandboxManager } from "./services/sandboxManager.service";
import { SlackNotifierService } from "./services/slackNotifier.service";
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

  const inboxService = new InboxService(inboxRepository, sandboxManager, linearTokenProvider);

  const agentSessionService = new AgentSessionService(
    taskRepository,
    inboxRepository,
    linearTokenProvider,
    sandboxManager,
    inboxService,
  );

  const slackNotifier = new SlackNotifierService(
    taskRepository,
    config.slack?.botToken ?? "",
    config.slack?.channel ?? "",
  );

  const eventDispatcher = new EventDispatcher(
    taskRepository,
    inboxRepository,
    sandboxManager,
    linearTokenProvider,
    slackNotifier,
  );

  const taskProcessor = new TaskProcessorService(
    taskRepository,
    inboxRepository,
    linearTokenProvider,
    sandboxManager,
    eventDispatcher,
    inboxService,
    slackNotifier,
  );

  const linearStatus = new LinearStatusService(
    config.linear ? linearTokenProvider : undefined,
    logger,
  );

  // Each webhook exists only when its integration is configured.
  const linearWebhookController = config.linear
    ? new LinearWebhookController(agentSessionService, (at) => linearStatus.recordWebhook(at))
    : undefined;
  const githubWebhookController = config.github.webhooks
    ? new GitHubWebhookController(inboxService, taskRepository, config.github.webhooks)
    : undefined;
  const githubStatus = new GithubStatusService(githubTokenState, {
    enabled: githubWebhookController !== undefined,
    ciResults: config.github.ciResultEnabled,
    lastWebhookAt: () => githubWebhookController?.lastWebhookAt() ?? null,
  });
  const healthController = new HealthController(db);

  const app = new Hono();
  app.route("/", createHealthRoutes(healthController));
  app.route(
    "/",
    createWebhookRoutes({ linear: linearWebhookController, github: githubWebhookController }),
  );

  // /api only mounts when explicitly enabled: a CP deployed before the
  // internal ingress exists must expose nothing.
  let stopApiStreams = () => {};
  if (config.api.enabled) {
    const apiTaskService = new ApiTaskService(
      apiTaskRepository,
      taskRepository,
      taskEventRepository,
      sandboxManager,
      {
        keyPrefix: config.api.taskKeyPrefix,
        publicBaseUrl: config.api.publicBaseUrl,
        now: () => new Date(),
      },
    );
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
        linearStatus: () => linearStatus.status(),
        githubStatus: () => githubStatus.status(),
      }),
    );
    stopApiStreams = () => apiController.closeStreams();
  }

  return { app, taskProcessor, stopApiStreams };
}
