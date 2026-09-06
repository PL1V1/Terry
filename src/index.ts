import { loadConfig, type Config } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { migrateUp } from "./db/migrate.ts";
import { Repo } from "./db/repo.ts";
import { Gateway, type DiscordMessage } from "./discord/gateway.ts";
import { Rest } from "./discord/rest.ts";
import { PresenceController, type ServiceState } from "./discord/presence.ts";
import { discoverCapabilities, assertPermissionSettings } from "./runtime/capabilities.ts";
import { RoomController } from "./controller/room.ts";
import { closeLogFile, log, registerSecret, setLogFile } from "./log.ts";

/**
 * Decides whether a message may be acted on.
 *
 * Three independent gates, all of which must pass: the room must be allowlisted,
 * the author must be an authorised operator, and the message must come from a
 * human. Discord is a transport, not an authority.
 */
export function isAuthorised(
  message: DiscordMessage,
  config: Config,
): { ok: true } | { ok: false; reason: string } {
  if (message.author?.bot) return { ok: false, reason: "author is a bot" };
  if (message.webhook_id) return { ok: false, reason: "message is a webhook" };
  if (!message.guild_id) return { ok: false, reason: "not a guild channel" };
  if (config.allowedGuilds.size > 0 && !config.allowedGuilds.has(message.guild_id)) {
    return { ok: false, reason: "guild not allowlisted" };
  }
  if (!config.allowedChannels.has(message.channel_id)) {
    return { ok: false, reason: "channel not allowlisted" };
  }
  if (!config.operators.has(message.author.id)) {
    return { ok: false, reason: "author is not an authorised operator" };
  }
  return { ok: true };
}

/**
 * Tracks each room's state and reduces them to the single presence the bot
 * shows. Working beats awake, awake beats asleep — the indicator reflects the
 * busiest room rather than whichever one changed last.
 */
class PresenceAggregator {
  private readonly states = new Map<string, { state: ServiceState; activity: string | null }>();

  constructor(private readonly presence: PresenceController) {}

  report(key: string, state: ServiceState, activity: string | null): void {
    this.states.set(key, { state, activity });
    this.apply();
  }

  connection(state: "connecting" | "ready" | "resuming" | "disconnected"): void {
    if (state === "ready") this.apply();
    else if (state === "disconnected") this.presence.set("unavailable");
    else this.presence.set("connecting");
  }

  private apply(): void {
    const values = [...this.states.values()];
    const working = values.find((v) => v.state === "working");
    if (working) return this.presence.set("working", working.activity);
    const awake = values.find((v) => v.state === "awake");
    if (awake) return this.presence.set("awake", awake.activity);
    this.presence.set("asleep", values[0]?.activity ?? null);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogFile(config.logFile);
  log.info("starting terry", {
    workspaceDir: config.workspaceDir,
    permissionMode: config.permissionMode,
    permissionPrompts: config.permissionPrompts,
    allowedChannels: config.allowedChannels.size,
    operators: config.operators.size,
  });

  const db = openDatabase(config.databasePath);
  const appliedVersions = migrateUp(db);
  if (appliedVersions.length) log.info("migrations applied", { versions: appliedVersions });

  const repo = new Repo(db);
  repo.pruneEvents();

  // A restart must not silently resume work nobody asked for. Conversation
  // mappings and preferences are kept, so waking a room picks it up again.
  if (!config.resumeAwakeOnRestart) {
    const wereAwake = repo.awakeRooms();
    if (wereAwake.length > 0) {
      repo.sleepAllRooms();
      log.info("rooms returned to asleep after restart", {
        count: wereAwake.length,
        rooms: wereAwake.map((r) => `${r.guild_id}/${r.channel_id}`),
      });
    }
  }

  const caps = await discoverCapabilities(config.claudeBin);
  assertPermissionSettings(caps, config.permissionMode, config.permissionPrompts);

  const rest = new Rest(config.token);
  const rooms = new Map<string, RoomController>();

  let botId = config.applicationId;
  let botName: string | null = null;
  let aggregator: PresenceAggregator | null = null;

  // Discord auto-creates a managed role per bot, and mentioning that role looks
  // identical to mentioning the bot. Both must count as addressing us.
  const selfRoleIds = new Set<string>();
  const selfMentionIds = (): ReadonlySet<string> => new Set([botId, ...selfRoleIds]);

  async function discoverSelfRoles(): Promise<void> {
    try {
      for (const guild of await rest.botGuilds()) {
        if (config.allowedGuilds.size > 0 && !config.allowedGuilds.has(guild.id)) continue;
        for (const role of await rest.guildRoles(guild.id)) {
          if (role.tags?.bot_id === botId) selfRoleIds.add(role.id);
        }
      }
      log.info("self mention ids resolved", { botId, roleIds: [...selfRoleIds] });
    } catch (error) {
      // Not fatal: the bot still answers a direct user mention.
      log.warn("could not resolve this bot's role ids; role mentions will be ignored", { error });
    }
  }

  const gateway = new Gateway(config.token, {
    onConnectionState: (state) => {
      log.info("gateway state", { state });
      aggregator?.connection(state);
    },

    onReady: (data) => {
      botId = data.user.id;
      botName = data.user.username ?? null;
      log.info("gateway ready", { botId, botName });
      void discoverSelfRoles();
      // A restart returns every room to asleep unless it was left awake, which
      // the database remembers; nothing is resumed without a mapping.
      aggregator?.connection("ready");
    },

    onMessage: (message) => {
      void handleMessage(message);
    },
  });

  const presence = new PresenceController(gateway);
  aggregator = new PresenceAggregator(presence);

  async function handleMessage(message: DiscordMessage): Promise<void> {
    const verdict = isAuthorised(message, config);
    if (!verdict.ok) {
      log.debug("message ignored", { reason: verdict.reason, channelId: message.channel_id });
      return;
    }

    // Discord replays events across RESUME. A replayed message must never run
    // the same work twice.
    if (!repo.markEventSeen(`message:${message.id}`)) {
      log.info("duplicate gateway event ignored", { messageId: message.id });
      return;
    }

    const guildId = message.guild_id!;
    const key = `${guildId}:${message.channel_id}`;
    let room = rooms.get(key);
    if (!room) {
      room = new RoomController(
        {
          config,
          repo,
          rest,
          caps,
          botId,
          botName,
          selfMentionIds,
          onActivity: (state, activity) => aggregator?.report(key, state, activity),
        },
        guildId,
        message.channel_id,
      );
      rooms.set(key, room);
    }

    try {
      await room.handleMessage(message);
    } catch (error) {
      log.error("room failed to handle message", { key, error });
    }
  }

  await gateway.connect();

  // Housekeeping: de-duplication keys do not need to live forever.
  const pruneTimer = setInterval(() => {
    const removed = repo.pruneEvents();
    if (removed) log.debug("pruned de-duplication keys", { removed });
  }, 6 * 60 * 60 * 1000);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    clearInterval(pruneTimer);
    presence.stop();
    gateway.close();
    await Promise.all([...rooms.values()].map((room) => room.shutdown()));
    db.close();
    closeLogFile();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // registerSecret has already run if config loaded, so this is safe to print.
    log.error("fatal", { error });
    process.exit(1);
  });
}

export { registerSecret };
