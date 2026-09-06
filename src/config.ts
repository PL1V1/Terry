import { registerSecret, setLogLevel, type LogLevel } from "./log.ts";
import { DRIFT_POLICIES, type DriftPolicy } from "./controller/pins.ts";

/** Which allowlist admitted a message, and therefore what it may do. */
export type AuthorKind = "operator" | "peer";

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
  /**
   * Bot ids allowed to address this one, so two agents can hold a conversation.
   * Named individually and never inferred: "is a bot" is not a credential, and
   * an empty set reproduces the original refuse-every-bot behaviour exactly.
   */
  peerAgents: Set<string>;
  /**
   * How many consecutive peer-authored turns a room takes before it stops and
   * waits for a human. Two mention-triggered agents will otherwise answer each
   * other until something runs out. Any operator message resets the count.
   */
  peerTurnLimit: number;
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
  /**
   * Permission mode used for a turn a PEER agent spoke.
   *
   * The runtime otherwise takes its authority from PERMISSION_MODE regardless of
   * who is talking, so widening that would hand a bot on somebody else s machine
   * exactly the authority an operator has. Peer turns run at this instead, which
   * defaults to plan: a peer can read and reason, and cannot write.
   */
  peerPermissionMode: string;
  /**
   * Instruction keys a room loads when it has declared none of its own.
   *
   * A room is created by the first message sent in it, with an empty key list,
   * so a new channel silently had no rules at all - no persona, no brevity, no
   * honesty rule - and nothing said so. Naming the keys here makes a new room
   * inherit them instead of arriving blank.
   */
  defaultInstructionKeys: string[];
  /** How many recent channel messages are supplied as background context. */
  historyLimit: number;
  /**
   * How long, in seconds, an awake room keeps listening to un-mentioned messages
   * after being addressed. The window opens on a mention and re-opens on every
   * reply, so a conversation stays live without being punctuated by mentions,
   * and closes when nobody has spoken to the room for this long.
   *
   * Zero disables ambient listening: a mention is then required every time, as
   * it was before this existed. Messages arriving outside an open window never
   * reach the runtime at all, which is what keeps idle chatter free.
   */
  attentionWindowSeconds: number;
  /**
   * What a room does when an instruction has changed since its conversation was
   * pinned. "hold" keeps the versions the conversation started with and reports
   * the change; "live" adopts the change and reports that; "off" disables
   * pinning entirely, resolving live every turn.
   */
  driftPolicy: DriftPolicy;
  /**
   * Whether a restart leaves awake rooms awake. Off by default: a restart
   * returns every room to asleep, keeping the conversation mapping so that
   * waking resumes it. Staying awake is a deliberate choice, not an accident.
   */
  resumeAwakeOnRestart: boolean;
  logLevel: LogLevel;
  /** Optional file the service appends its own structured log to. */
  logFile: string | null;
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

  const driftPolicyRaw = (env.INSTRUCTION_DRIFT_POLICY?.trim() || "hold") as DriftPolicy;
  if (!DRIFT_POLICIES.includes(driftPolicyRaw)) {
    throw new ConfigError(`INSTRUCTION_DRIFT_POLICY must be one of ${DRIFT_POLICIES.join(", ")}`);
  }

  const config: Config = {
    token,
    applicationId: required("DISCORD_APPLICATION_ID", env),
    databasePath: env.DATABASE_PATH?.trim() || "./data/terry.sqlite",
    allowedGuilds: idSet("ALLOWED_GUILDS", env),
    allowedChannels: idSet("ALLOWED_CHANNELS", env),
    operators: idSet("OPERATORS", env),
    peerAgents: idSet("PEER_AGENTS", env),
    peerTurnLimit: intOr("PEER_TURN_LIMIT", env, 6),
    claudeBin: env.CLAUDE_BIN?.trim() || "claude",
    workspaceDir: env.WORKSPACE_DIR?.trim() || process.cwd(),
    defaultModel: env.DEFAULT_MODEL?.trim() || null,
    defaultEffort: env.DEFAULT_EFFORT?.trim() || null,
    // Defaults deliberately fail closed. Widening the runtime's authority is an
    // operator decision made in the environment, never from a chat message.
    permissionMode: env.PERMISSION_MODE?.trim() || "plan",
    permissionPrompts: env.PERMISSION_PROMPTS?.trim() || "none",
    peerPermissionMode: env.PEER_PERMISSION_MODE?.trim() || "plan",
    defaultInstructionKeys: (env.DEFAULT_INSTRUCTION_KEYS ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    historyLimit: intOr("HISTORY_LIMIT", env, 25),
    attentionWindowSeconds: intOr("ATTENTION_WINDOW_SECONDS", env, 90),
    driftPolicy: driftPolicyRaw,
    resumeAwakeOnRestart: (env.RESUME_AWAKE_ON_RESTART?.trim() ?? "").toLowerCase() === "true",
    logLevel: logLevelRaw,
    logFile: env.LOG_FILE?.trim() || null,
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
