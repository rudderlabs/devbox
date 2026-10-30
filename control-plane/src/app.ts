import { Hono } from "hono";
import { githubTokenState } from "./clients/github";
import { realClock } from "./clock";
import { config } from "./config";
import { ApiController } from "./controllers/api.controller";
import { GitHubWebhookController } from "./controllers/githubWebhook.controller";
import { HealthController } from "./controllers/health.controller";
import { LinearWebhookController } from "./controllers/linearWebhook.controller";
import { db } from "./db";
import { taskSource } from "./db/schema";
import { apiIntegration } from "./integrations/api";
import { githubIntegration } from "./integrations/github";
import { Intake } from "./integrations/intake";
import { LinearIntegration } from "./integrations/linear";
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
import { AgentSessionService } from "./services/agentSession.service";
import { ApiAuthService } from "./services/apiAuth.service";
import { ApiTaskService } from "./services/apiTask.service";
import { EventDispatcher } from "./services/eventDispatcher";
import { GithubStatusService } from "./services/githubStatus.service";
import { InboxService } from "./services/inbox.service";
import { IntegrationHooks } from "./services/integrationHooks";
import { LinearStatusService } from "./services/linearStatus.service";
import { LinearTokenProvider } from "./services/linearTokenProvider";
import { ReplyHolds } from "./services/replyHolds";
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

  // Every outbound message goes through integrations[round.source].deliver.
  const integrations = {
    linear: new LinearIntegration(linearTokenProvider),
    api: apiIntegration,
    github: githubIntegration,
  } satisfies Record<IntegrationName, Integration>;
  // The registered integrations that create tasks (github creates none). Only
  // these sources are claimed and reconciled, so an older image never works a
  // task whose source it doesn't know (§10).
  const taskSources = taskSource.enumValues.filter((s) => s in integrations);
  // Sends held because they failed before anything went out; the status
  // routes will report them per integration (phase 2).
  const replyHolds = new ReplyHolds();
  // Integrations' lifecycle hooks; TaskProcessor.stop() drains detached ones.
  const hooks = new IntegrationHooks(integrations, inboxRepository);
  // The only way tasks and rounds are created; a restart's preempted sandbox
  // is killed in the hooks' tracked detached set.
  const intake = new Intake(taskRepository, inboxRepository, sandboxManager, hooks, {
    apiKeyPrefix: config.api.taskKeyPrefix,
    ciResultMaxPerTask: config.github.ciResultMaxPerTask,
  });

  const inboxService = new InboxService(
    inboxRepository,
    sandboxManager,
    integrations,
    hooks,
    intake,
  );

  const agentSessionService = new AgentSessionService(intake, linearTokenProvider, inboxService);

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
    integrations,
    replyHolds,
    hooks,
  );

  const taskProcessor = new TaskProcessorService(
    taskRepository,
    inboxRepository,
    linearTokenProvider,
    sandboxManager,
    eventDispatcher,
    inboxService,
    slackNotifier,
    integrations,
    replyHolds,
    taskSources,
    hooks,
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
    ? new GitHubWebhookController(inboxService, intake, config.github.webhooks)
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
    const apiTaskService = new ApiTaskService(apiTaskRepository, intake, taskEventRepository, {
      publicBaseUrl: config.api.publicBaseUrl,
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
        linearStatus: () => linearStatus.status(),
        githubStatus: () => githubStatus.status(),
      }),
    );
    stopApiStreams = () => apiController.closeStreams();
  }

  return { app, taskProcessor, stopApiStreams };
}
