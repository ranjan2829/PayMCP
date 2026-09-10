import { randomUUID } from "node:crypto";
import { redactPaymentSignature } from "./sanitize.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  child(bindings: LogFields): Logger;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/**
 * Minimal structured JSON logger (pino-compatible shape).
 * Avoids a hard pino dependency so the published package stays lean;
 * demo-api can swap in real pino via Fastify logger.
 */
export function createLogger(
  bindings: LogFields = {},
  opts: { level?: LogLevel; name?: string } = {},
): Logger {
  const minLevel = rank(opts.level ?? (process.env["LOG_LEVEL"] as LogLevel) ?? "info");
  const base = {
    ...(opts.name !== undefined ? { name: opts.name } : { name: "paymcp" }),
    ...bindings,
  };

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (rank(level) < minLevel) return;
    const line = {
      level,
      time: new Date().toISOString(),
      ...base,
      ...sanitizeFields(fields ?? {}),
      msg: redactPaymentSignature(msg),
    };
    const out = JSON.stringify(line);
    if (level === "error") {
      process.stderr.write(`${out}\n`);
    } else {
      process.stdout.write(`${out}\n`);
    }
  };

  const self: Logger = {
    child(childBindings) {
      return createLogger({ ...base, ...childBindings }, opts);
    },
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
  return self;
}

export function newRequestId(): string {
  return randomUUID();
}

function rank(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 10;
    case "info":
      return 20;
    case "warn":
      return 30;
    case "error":
      return 40;
    default:
      return 20;
  }
}

function sanitizeFields(fields: LogFields): LogFields {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const keyLower = k.toLowerCase();
    if (
      keyLower.includes("payment-signature") ||
      keyLower.includes("paymentsignature") ||
      keyLower.includes("authorization") ||
      keyLower.includes("auth_token") ||
      keyLower.includes("authtoken") ||
      keyLower.includes("secret") ||
      keyLower.includes("private")
    ) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (typeof v === "string") {
      out[k] = redactPaymentSignature(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
