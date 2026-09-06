export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level];
}

/**
 * Values that must never reach a log line or a user-facing error. Anything
 * registered here is replaced with a fixed marker wherever it appears.
 */
const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(input: string): string {
  let out = input;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

function emit(level: LogLevel, message: string, fields: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  const line = redact(JSON.stringify(record, replacer));
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export const log = {
  debug: (msg: string, fields: Record<string, unknown> = {}) => emit("debug", msg, fields),
  info: (msg: string, fields: Record<string, unknown> = {}) => emit("info", msg, fields),
  warn: (msg: string, fields: Record<string, unknown> = {}) => emit("warn", msg, fields),
  error: (msg: string, fields: Record<string, unknown> = {}) => emit("error", msg, fields),
};
