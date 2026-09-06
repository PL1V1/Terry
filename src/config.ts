import { registerSecret, setLogLevel, type LogLevel } from "./log.ts";

export interface Config {
  /** Discord bot token. Read from the environment only; never persisted. */
  token: string;
  /** Application id of the bot, used to recognise its own mentions. */
  applicationId: string;
  databasePath: string;
  /** Guild ids the service will answer in. Empty means none. */
  allowedGuilds: Set<string>;
  /** Channel ids the service will answer in. Empty means none. */
  allowedChannels: Set<string>;
  /** User ids permitted to issue commands and queue work. Empty means none. */
  operators: Set<string>;
  claudeBin: string;
  /** Working directory handed to the coding runtime. */
  workspaceDir: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  /**
   * Permission mode passed to the coding runtime. Discord input must not widen
   * the runtime's authority, so this is deliberately operator-configured and
   * never settable from chat.
   */
  permissionMode: string;
  /**
   * Who answers permission prompts. "none" fails closed: an action needing
   * approval is refused rather than silently allowed.
   */
  permissionPrompts: string;
  /** How many recent channel messages are supplied as background context. */
  historyLimit: number;
  logLevel: LogLevel;
}

class ConfigError extends Error {}

function required(name: string, env: Record<string, string | undefined>): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
  return value;
}

function idSet(name: string, env: Record<string, string | undefined>): Set<string> {
  const raw = env[name]?.trim() ?? "";
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!/^\d{5,}$/.test(id)) {
      throw new ConfigError(`${name} contains a value that is not a Discord snowflake: ${id}`);
    }
  }
  return new Set(ids);
}

function intOr(name: string, env: Record<string, string | undefined>, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer`);
  return n;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const token = required("DISCORD_TOKEN", env);
  // Registered before anything else so an early crash cannot print it.
  registerSecret(token);

  const logLevelRaw = (env.LOG_LEVEL?.trim() ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevelRaw)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }

  const config: Config = {
    token,
    applicationId: required("DISCORD_APPLICATION_ID", env),
    databasePath: env.DATABASE_PATH?.trim() || "./data/terry.sqlite",
    allowedGuilds: idSet("ALLOWED_GUILDS", env),
    allowedChannels: idSet("ALLOWED_CHANNELS", env),
    operators: idSet("OPERATORS", env),
    claudeBin: env.CLAUDE_BIN?.trim() || "claude",
    workspaceDir: env.WORKSPACE_DIR?.trim() || process.cwd(),
    defaultModel: env.DEFAULT_MODEL?.trim() || null,
    defaultEffort: env.DEFAULT_EFFORT?.trim() || null,
    // Defaults deliberately fail closed. Widening the runtime's authority is an
    // operator decision made in the environment, never from a chat message.
    permissionMode: env.PERMISSION_MODE?.trim() || "plan",
    permissionPrompts: env.PERMISSION_PROMPTS?.trim() || "none",
    historyLimit: intOr("HISTORY_LIMIT", env, 25),
    logLevel: logLevelRaw,
  };

  // An empty allowlist is a configuration mistake, not an open door. Fail loudly
  // rather than starting a bot that answers anybody.
  if (config.allowedChannels.size === 0) {
    throw new ConfigError("ALLOWED_CHANNELS is empty; refusing to start with no channel allowlist");
  }
  if (config.operators.size === 0) {
    throw new ConfigError("OPERATORS is empty; refusing to start with no authorised operators");
  }

  setLogLevel(config.logLevel);
  return config;
}

export { ConfigError };
