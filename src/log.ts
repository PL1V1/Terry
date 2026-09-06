import { createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;

/**
 * Optional log file, owned by this process.
 *
 * The service writes its own log rather than being redirected into one by a
 * launcher. A wrapper holding the file handle can outlive the service, or be
 * killed while the service survives, and either way the next start cannot open
 * the file. Owning the handle ties its lifetime to the process that is doing
 * the logging.
 */
let sink: WriteStream | null = null;

export function setLogFile(path: string | null): void {
  sink?.end();
  sink = null;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });

  // A process left over from an earlier run can still hold the day's log open,
  // and on Windows that blocks this one from appending to it. Losing the log is
  // worth tolerating; refusing to start over it is not, so fall back to a
  // process-specific file and say so.
  try {
    const stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
    stream.on("error", (error) => {
      console.error(`log file ${path} failed mid-run: ${String(error)}`);
    });
    sink = stream;
    return;
  } catch (error) {
    const fallback = path.replace(/.log$/, "") + `-${process.pid}.log`;
    try {
      sink = createWriteStream(fallback, { flags: "a", encoding: "utf8" });
      console.error(`could not open ${path} (${String(error)}); logging to ${fallback}`);
    } catch {
      console.error(`could not open a log file at all; logging to stdout only`);
      sink = null;
    }
  }
}

export function closeLogFile(): void {
  sink?.end();
  sink = null;
}

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
  if (sink) {
    sink.write(`${line}
`);
    return;
  }
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
