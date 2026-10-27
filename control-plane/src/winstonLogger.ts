import winston from "winston";

type LogMessage = string | Error | unknown;
type Metadata = object;

const DEFAULT_REDACTED: Array<string | RegExp> = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
];
let redacted: Array<string | RegExp> = DEFAULT_REDACTED;
let base: Record<string, unknown> = {};

function isRedacted(key: string): boolean {
  return redacted.some((r) =>
    typeof r === "string" ? r.toLowerCase() === key.toLowerCase() : r.test(key),
  );
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, isRedacted(k) ? "[REDACTED]" : redact(v, seen)]),
  );
}

const impl = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

function emit(
  level: "debug" | "info" | "warn" | "error",
  message: LogMessage,
  metadata?: Metadata,
) {
  const msg =
    message instanceof Error
      ? message.message
      : typeof message === "string"
        ? message
        : JSON.stringify(redact(message));
  const extra = message instanceof Error ? { stack: message.stack } : {};
  impl.log(level, msg, { ...base, ...(redact(metadata ?? {}) as object), ...extra });
}

export const logger = {
  debug: (m: LogMessage, md?: Metadata) => emit("debug", m, md),
  info: (m: LogMessage, md?: Metadata) => emit("info", m, md),
  warn: (m: LogMessage, md?: Metadata) => emit("warn", m, md),
  error: (m: LogMessage, md?: Metadata) => emit("error", m, md),
};

export function setup(
  service: string,
  metadata: Metadata,
  redactedKeys?: Array<string | RegExp>,
): void {
  base = { service, ...(metadata as Record<string, unknown>) };
  if (redactedKeys) redacted = redactedKeys;
}
