import type { Config } from "../config.ts";
import type { Repo, Room } from "../db/repo.ts";
import type { MessageTransport } from "../discord/rest.ts";
import type { DiscordMessage } from "../discord/gateway.ts";
import type { ServiceState } from "../discord/presence.ts";
import type { Capabilities } from "../runtime/capabilities.ts";
import { ClaudeSession } from "../runtime/claude.ts";
import { parseInput, menuText, type ParsedCommand } from "./commands.ts";
import { fetchHistory, renderHistory } from "./history.ts";
import { log } from "../log.ts";

export interface RoomDeps {
  config: Config;
  repo: Repo;
  rest: MessageTransport;
  caps: Capabilities;
  botId: string;
  /** Readable name for instructional text, e.g. "Terry". */
  botName: string | null;
  /**
   * Every id that counts as addressing this bot: its user id plus its managed
   * role ids. Read through a callback because role discovery is asynchronous.
   */
  selfMentionIds: () => ReadonlySet<string>;
  /** Reports this room's activity so the service can drive presence. */
  onActivity: (state: ServiceState, activity: string | null) => void;
}

interface PendingTurn {
  text: string;
  authorId: string;
  messageId: string;
}

/**
 * One Discord channel's conversation.
 *
 * Owns the room's state machine (asleep / awake / working), the runtime process,
 * and the queue of turns waiting behind whatever is currently running.
 */
export class RoomController {
  private session: ClaudeSession | null = null;
  private queue: PendingTurn[] = [];
  private running = false;
  /** Model and effort the live process was started with. */
  private activeSettings: { model: string | null; effort: string | null } | null = null;
  private awaitingNewSessionConfirm = false;
  private historySent = false;

  constructor(
    private readonly deps: RoomDeps,
    readonly guildId: string,
    readonly channelId: string,
  ) {}

  private get room(): Room {
    return this.deps.repo.ensureRoom(this.guildId, this.channelId);
  }

  /**
   * How the bot is written in examples. A readable name where we know it,
   * because these appear inside code spans where a real mention would render
   * as raw angle brackets and digits.
   */
  private get mention(): string {
    return this.deps.botName ? `@${this.deps.botName}` : `<@${this.deps.botId}>`;
  }

  private async say(text: string, replyTo?: string): Promise<void> {
    try {
      await this.deps.rest.sendMessage(this.channelId, text, replyTo ? { replyTo } : {});
    } catch (error) {
      // A delivery failure must be visible in the logs even though the user
      // cannot be told — telling them is precisely what just failed.
      log.error("failed to deliver message to discord", { channelId: this.channelId, error });
    }
  }

  private setState(state: ServiceState): void {
    const room = this.room;
    const activity = room.activity_mode === "custom" ? room.activity_text : null;
    this.deps.onActivity(state, activity);
  }

  // ---------------------------------------------------------------- dispatch

  async handleMessage(message: DiscordMessage): Promise<void> {
    const parsed = parseInput(message.content ?? "", this.deps.selfMentionIds());
    if (!parsed.mentioned) {
      // Logged deliberately. A silently dropped message is indistinguishable
      // from a dead service, and that costs an hour of somebody's afternoon.
      log.debug("message not addressed to this bot", {
        channelId: this.channelId,
        messageId: message.id,
        empty: (message.content ?? "").length === 0,
      });
      return;
    }

    if (parsed.command) {
      await this.handleCommand(parsed.command, message);
      return;
    }

    // Ordinary conversation. Ignored entirely while asleep, per the brief.
    if (this.room.state === "asleep") {
      log.debug("ignoring chat while asleep", { channelId: this.channelId });
      return;
    }
    if (!parsed.text) return;

    await this.enqueue({ text: parsed.text, authorId: message.author.id, messageId: message.id });
  }

  private async handleCommand(command: ParsedCommand, message: DiscordMessage): Promise<void> {
    // Any command other than the confirmation cancels a pending new-session ask.
    if (command.name !== "confirm-new-session") this.awaitingNewSessionConfirm = false;

    switch (command.name) {
      case "menu":
        return this.say(menuText(this.mention));
      case "ping":
        return this.say(`Pong. Runtime ${this.deps.caps.version ?? "version unknown"}, room ${this.room.state}.`);
      case "status":
        return this.say(this.statusText());
      case "wakeup":
        return this.wakeup();
      case "sleep":
        return this.sleep();
      case "stop":
        return this.stop();
      case "list-models":
        return this.say(this.modelsText());
      case "model":
        return this.setModel(command.arg);
      case "effort":
        return command.arg ? this.setEffort(command.arg) : this.say(this.effortText());
      case "new-session":
        return this.askNewSession();
      case "confirm-new-session":
        return this.confirmNewSession();
      case "activity":
        return this.setActivity(command.arg, message);
    }
  }

  // ---------------------------------------------------------------- commands

  private statusText(): string {
    const room = this.room;
    const lines = [
      `**Room** ${room.state}${this.running ? " — working" : ""}`,
      `**Conversation** ${room.session_id ?? "none yet"}`,
      `**Model** ${room.model ?? this.deps.config.defaultModel ?? "runtime default"}`,
      `**Effort** ${room.effort ?? this.deps.config.defaultEffort ?? "runtime default"}`,
      `**Permissions** mode \`${this.deps.config.permissionMode}\`, prompts \`${this.deps.config.permissionPrompts}\``,
      `**Runtime** ${this.deps.caps.version ?? "version unknown"}`,
    ];
    if (this.queue.length) lines.push(`**Queued** ${this.queue.length} message(s) waiting`);
    if (this.activeSettings && (this.activeSettings.model !== room.model || this.activeSettings.effort !== room.effort)) {
      lines.push("_Model or effort changed; it takes effect on the next turn._");
    }
    return lines.join("\n");
  }

  private modelsText(): string {
    const aliases = this.deps.caps.modelAliases;
    if (!aliases || aliases.length === 0) {
      return [
        "The installed runtime does not expose a way to list models, so I cannot give you a catalogue.",
        "It accepts an alias or a full model name, which I will validate by trying it.",
      ].join("\n");
    }
    return [
      "**Models the runtime documents:**",
      ...aliases.map((alias) => `- \`${alias}\``),
      "",
      "This is what the runtime advertises in its own help, not a complete catalogue —",
      "full model names are accepted too. Set one with `model <id>`.",
    ].join("\n");
  }

  private effortText(): string {
    const levels = this.deps.caps.effortLevels;
    if (!levels || levels.length === 0) {
      return "The installed runtime does not advertise effort levels, so I cannot offer a list.";
    }
    const current = this.room.effort ?? this.deps.config.defaultEffort ?? "runtime default";
    return `**Effort levels:** ${levels.map((l) => `\`${l}\``).join(", ")}\nCurrently: **${current}**`;
  }

  private async setModel(arg: string): Promise<void> {
    if (!arg) return this.say(`Give me a model, e.g. \`${this.mention} model opus\`.`);
    this.deps.repo.setModel(this.guildId, this.channelId, arg);
    const known = this.deps.caps.modelAliases?.includes(arg);
    const note = known
      ? ""
      : "\n_That is not one of the aliases the runtime advertises. I have saved it; if the runtime rejects it you will see the error on the next turn._";
    await this.say(`Model set to **${arg}**. Applies to the next turn.${note}`);
  }

  private async setEffort(arg: string): Promise<void> {
    const levels = this.deps.caps.effortLevels;
    const value = arg.toLowerCase();
    if (levels && !levels.includes(value)) {
      return this.say(
        `**${arg}** is not a supported effort level. The runtime accepts: ${levels.map((l) => `\`${l}\``).join(", ")}.`,
      );
    }
    if (!levels) {
      return this.say("The installed runtime does not advertise effort levels, so I will not pretend to set one.");
    }
    this.deps.repo.setEffort(this.guildId, this.channelId, value);
    await this.say(`Effort set to **${value}**. Applies to the next turn.`);
  }

  private async setActivity(arg: string, message: DiscordMessage): Promise<void> {
    if (!arg) return this.say(`Give me some text, or \`${this.mention} activity auto\`.`);
    if (arg.toLowerCase() === "auto") {
      this.deps.repo.setActivity(this.guildId, this.channelId, "auto", null);
      this.setState(this.currentServiceState());
      return this.say("Activity text back to automatic.");
    }
    const text = arg.slice(0, 128);
    this.deps.repo.setActivity(this.guildId, this.channelId, "custom", text);
    this.setState(this.currentServiceState());
    await this.say(`Activity text set to: ${text}`, message.id);
  }

  private currentServiceState(): ServiceState {
    if (this.room.state === "asleep") return "asleep";
    return this.running ? "working" : "awake";
  }

  // ------------------------------------------------------------- lifecycle

  private async wakeup(): Promise<void> {
    const room = this.room;
    if (room.state === "awake" && this.session?.isRunning) {
      return this.say(`Already awake. ${this.running ? "Currently working." : "Idle and ready."}`);
    }
    this.deps.repo.setState(this.guildId, this.channelId, "awake");
    this.historySent = false;

    const resuming = Boolean(room.session_id);
    if (!room.session_id) {
      this.deps.repo.setSession(this.guildId, this.channelId, crypto.randomUUID());
    }
    this.setState("awake");
    await this.say(
      resuming
        ? `Awake. Resuming this room's conversation \`${room.session_id}\`.`
        : "Awake. Starting a new conversation for this room.",
    );
  }

  private async sleep(): Promise<void> {
    const dropped = this.queue.length;
    this.queue = [];
    await this.session?.stop();
    this.session = null;
    this.running = false;
    this.activeSettings = null;
    this.deps.repo.setState(this.guildId, this.channelId, "asleep");
    this.setState("asleep");
    await this.say(
      [
        "Asleep. I will ignore ordinary chat in here until you wake me.",
        dropped > 0 ? `Dropped ${dropped} queued message(s).` : "",
        `\`${this.mention} menu\` and \`${this.mention} status\` still work.`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  private async stop(): Promise<void> {
    const dropped = this.queue.length;
    this.queue = [];
    if (!this.running && !this.session?.isRunning) {
      return this.say("Nothing running. Still awake.");
    }
    await this.session?.stop();
    this.session = null;
    this.running = false;
    this.activeSettings = null;
    this.setState("awake");
    await this.say(
      [
        "Task interrupted. Still awake — the conversation is kept and the next message resumes it.",
        dropped > 0 ? `Cleared ${dropped} queued message(s).` : "Nothing was queued.",
      ].join(" "),
    );
  }

  private async askNewSession(): Promise<void> {
    this.awaitingNewSessionConfirm = true;
    const current = this.room.session_id ?? "none";
    await this.say(
      [
        "**This replaces this room's conversation.** The new one starts with no memory of what we have discussed here.",
        `The current conversation (\`${current}\`) is **not deleted** — it is filed in history and stays resumable.`,
        "",
        `Send \`${this.mention} new session confirm\` to go ahead. Any other command cancels.`,
      ].join("\n"),
    );
  }

  private async confirmNewSession(): Promise<void> {
    if (!this.awaitingNewSessionConfirm) {
      return this.say(`Nothing to confirm. Run \`${this.mention} new session\` first.`);
    }
    this.awaitingNewSessionConfirm = false;
    this.queue = [];
    await this.session?.stop();
    this.session = null;
    this.running = false;
    this.activeSettings = null;

    const retired = this.deps.repo.retireSession(this.guildId, this.channelId, "new session requested");
    const fresh = crypto.randomUUID();
    this.deps.repo.setSession(this.guildId, this.channelId, fresh);
    this.deps.repo.setState(this.guildId, this.channelId, "awake");
    this.historySent = false;
    this.setState("awake");

    await this.say(
      [
        `New conversation \`${fresh}\`.`,
        retired ? `The previous one (\`${retired}\`) is preserved and still resumable by id.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  // ------------------------------------------------------------------ turns

  private async enqueue(turn: PendingTurn): Promise<void> {
    this.queue.push(turn);
    if (this.running) {
      await this.say(`Queued — I am working. ${this.queue.length} message(s) waiting.`, turn.messageId);
      return;
    }
    await this.drain();
  }

  private async drain(): Promise<void> {
    while (!this.running && this.queue.length > 0) {
      const turn = this.queue.shift()!;
      await this.runTurn(turn);
    }
  }

  /**
   * Starts or restarts the runtime process when the room's model or effort no
   * longer matches the running one. Restarting resumes the same conversation by
   * id, so changing a setting costs context nothing.
   */
  private async ensureSession(): Promise<ClaudeSession> {
    const room = this.room;
    const model = room.model ?? this.deps.config.defaultModel;
    const effort = room.effort ?? this.deps.config.defaultEffort;

    const settingsChanged =
      this.activeSettings !== null &&
      (this.activeSettings.model !== model || this.activeSettings.effort !== effort);

    if (this.session?.isRunning && !settingsChanged) return this.session;

    if (this.session) {
      log.info("restarting runtime to apply new settings", { channelId: this.channelId, model, effort });
      await this.session.stop();
    }

    const sessionId = room.session_id ?? crypto.randomUUID();
    if (!room.session_id) this.deps.repo.setSession(this.guildId, this.channelId, sessionId);

    // A conversation that has already produced a turn is resumed, not recreated.
    const resume = this.historySent || settingsChanged;

    const session = new ClaudeSession({
      bin: this.deps.config.claudeBin,
      cwd: this.deps.config.workspaceDir,
      sessionId,
      resume,
      model,
      effort,
      permissionMode: this.deps.config.permissionMode,
      permissionPrompts: this.deps.config.permissionPrompts,
      onEvent: (event) => {
        if (event.kind === "stderr") log.warn("runtime stderr", { channelId: this.channelId, text: event.text });
        if (event.kind === "parse-error") log.warn("runtime emitted unparseable output", { line: event.line });
        if (event.kind === "exit" && !event.expected) {
          log.error("runtime exited unexpectedly", { channelId: this.channelId, code: event.code });
        }
      },
    });
    session.start();
    this.session = session;
    this.activeSettings = { model, effort };
    return session;
  }

  private async runTurn(turn: PendingTurn): Promise<void> {
    this.running = true;
    this.setState("working");

    try {
      // The prompt is assembled first: a turn that is going to be refused
      // should never cost a runtime process.
      const built = await this.buildPrompt(turn);
      if ("error" in built) {
        await this.say(built.error, turn.messageId);
        return;
      }

      const session = await this.ensureSession();
      const outcome = await session.runTurn(built.prompt);

      // The history block is only ever sent once per conversation.
      this.historySent = true;

      if (outcome.text?.trim()) {
        await this.say(outcome.text.trim(), turn.messageId);
      } else if (outcome.reason === "interrupted") {
        // The stop and sleep commands already told the user; saying it twice
        // would be noise.
      } else if (outcome.ok) {
        await this.say("Finished, and the runtime returned nothing to show.");
      } else {
        await this.say(this.failureText(outcome.reason));
      }

      // A process that died on its own cannot be reused; the next turn respawns
      // it and resumes the conversation by id.
      if (outcome.reason === "exited") {
        this.session = null;
        this.activeSettings = null;
      }
    } catch (error) {
      log.error("turn failed", { channelId: this.channelId, error });
      await this.say(`That turn failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.running = false;
      this.setState(this.currentServiceState());
      void this.drain();
    }
  }

  private failureText(reason: string): string {
    if (reason === "exited") {
      return "The runtime exited before finishing. The conversation is kept — send it again and it will resume.";
    }
    if (reason === "not-running") {
      return "Could not reach the runtime process. It is not running.";
    }
    return `The runtime reported a problem (${reason}). The conversation is kept.`;
  }

  /**
   * Resolves this room's instruction keys against the registry.
   *
   * Instructions are read on every turn rather than cached, so an edit in the
   * registry is visible on the next message with no restart. A key marked
   * required that resolves to nothing is a visible error, never a silent skip.
   */
  private renderInstructions(): { text: string; missing: string[] } {
    const keys = this.deps.repo.roomInstructionKeys(this.guildId, this.channelId);
    const bodies: string[] = [];
    const missing: string[] = [];

    for (const key of keys) {
      const row = this.deps.repo.resolveInstruction(key, this.guildId, this.channelId);
      if (!row) {
        if (this.deps.repo.isRequired(key)) missing.push(key);
        else log.warn("instruction key resolved to nothing", { key, channelId: this.channelId });
        continue;
      }
      bodies.push(`## ${row.key} (${row.scope})\n${row.body}`);
    }

    const text = bodies.length ? ["<instructions>", ...bodies, "</instructions>"].join("\n\n") : "";
    return { text, missing };
  }

  /**
   * Builds the turn text: instructions on every turn, channel history once, then
   * the operator's own message.
   */
  private async buildPrompt(turn: PendingTurn): Promise<{ prompt: string } | { error: string }> {
    const instructions = this.renderInstructions();
    if (instructions.missing.length > 0) {
      return {
        error: [
          "**Required instructions are missing from the registry, so I have not run that.**",
          `Missing: ${instructions.missing.join(", ")}`,
          "Add them to the registry, or take them off this room's instruction list.",
        ].join("\n"),
      };
    }

    const parts: string[] = [];
    if (instructions.text) parts.push(instructions.text);

    if (!this.historySent) {
      const messages = await fetchHistory(this.deps.rest, this.channelId, {
        limit: this.deps.config.historyLimit,
        excludeId: turn.messageId,
      });
      const history = renderHistory(messages);
      if (history) parts.push(history);
    }

    parts.push(turn.text);
    return { prompt: parts.join("\n\n") };
  }

  async shutdown(): Promise<void> {
    this.queue = [];
    await this.session?.stop();
    this.session = null;
  }
}
