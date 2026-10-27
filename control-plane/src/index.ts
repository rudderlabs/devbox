import { createApp } from "./app";
import { config } from "./config";
import { runMigrations } from "./db/migrate";
import { logger, setup as setupLogger } from "./logger";
import { MAX_REQUEST_BODY_SIZE_BYTES } from "./requestLimits";

setupLogger("devbox-control-plane", {}, [/token/i, /secret/i, /password/i, /authorization/i]);

if (config.autoMigrate) {
  logger.info("Running migrations");
  await runMigrations();
  logger.info("Migrations complete");
}

const { app, taskProcessor, stopApiStreams } = createApp();
if (config.api.enabled && !config.api.authEnabled) {
  logger.warn(
    "API auth is DISABLED (API_AUTH_ENABLED=false): /api accepts unauthenticated requests",
  );
}

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE_BYTES,
});

logger.info("Listening", { port: server.port, podId: config.podId });

taskProcessor.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutting down", { signal });
  stopApiStreams();
  await taskProcessor.stop();
  server.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
