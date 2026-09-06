import type { AuthorKind, Config } from "../config.ts";
import type { Repo, Room } from "../db/repo.ts";
import type { MessageTransport } from "../discord/rest.ts";
import type { DiscordMessage } from "../discord/gateway.ts";
import type { ServiceState } from "../discord/presence.ts";
import type { Capabilities } from "../runtime/capabilities.ts";
import { ClaudeSession } from "../runtime/claude.ts";
import { parseInput, menuText, type ParsedCommand } from "./commands.ts";
import { ambientPreamble, isDecline } from "./attention.ts";
import {
  driftNotice,
  hashBody,
  planPacket,
  renderPacket,
  type Instruction,
} from "./pins.ts";
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
  /** Whether an operator or a peer agent spoke this turn. */
  author: AuthorKind;
  /** True when nobody addressed the bot and it must decide whether to answer. */
  ambient: boolean;
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
  private activeSettings: { model: string | null; effort: string | null; permissionMode: string } | null = null;
  private awaitingNewSessionConfirm = false;
  /**
   * The newest message already given to the runtime as context. Null means the
   * conversation has had none yet, and the next turn carries a full block.
   */
  private lastHistoryId: string | null = null;
  /** Peer turns taken since an operator last spoke. Reset by any operator message. */
  private peerTurns = 0;
  /** Whether the room has already said it stopped, so it says it once. */
  private peerLimitAnnounced = false;
  /** The drift state already reported, so each distinct one is reported once. */
  private announcedDrift: string | null = null;
  /** When the attention window closes, as an epoch time. Null means closed. */
  private attentionUntil: number | null = null;

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

  /**
   * Posts to the room.
   *
   * Mentions are suppressed by default, so an answer cannot ping whoever the
   * runtime happened to name. Passing addressTo is the deliberate exception: it
   * prefixes a real mention and permits it, which is the only way a peer agent
   * waiting to be addressed ever hears a reply. Every such call is budgeted.
   */
  private async say(text: string, replyTo?: string, addressTo?: string | null): Promise<void> {
    const body = addressTo ? `<@${addressTo}> ${text}` : text;
    try {
      await this.deps.rest.sendMessage(this.channelId, body, {
        ...(replyTo ? { replyTo } : {}),
        ...(addressTo ? { allowMentions: true } : {}),
      });
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

  async handleMessage(message: DiscordMessage, author: AuthorKind = "operator"): Promise<void> {
    const parsed = parseInput(message.content ?? "", this.deps.selfMentionIds());

    // Un-mentioned messages are considered only inside an open attention window,
    // and only from a human. A peer always addresses this bot explicitly: two
    // agents reading each other's ambient chatter would have nothing but the
    // turn budget between them and a conversation nobody asked for.
    let ambient = false;
    if (!parsed.mentioned) {
      if (author !== "operator" || !this.listening()) {
        // Logged deliberately. A silently dropped message is indistinguishable
        // from a dead service, and that costs an hour of somebody's afternoon.
        log.debug("message not addressed to this bot", {
          channelId: this.channelId,
          messageId: message.id,
          listening: this.listening(),
          author,
        });
        return;
      }
      ambient = true;
    }

    // A human speaking is what the peer budget runs on. Their turn refills it
    // and re-arms the notice, so a stalled agent conversation resumes simply by
    // someone joining in.
    if (author === "operator") {
      this.peerTurns = 0;
      this.peerLimitAnnounced = false;
    }

    // Being addressed directly opens the window, whether or not the message is
    // a command: telling him to wake up is talking to him.
    if (parsed.mentioned && author === "operator") this.openAttention();

    if (parsed.command) {
      if (author === "peer") {
        // Commands sleep the room, stop work in flight, change the model and
        // start new conversations. A peer may hold a conversation; it does not
        // hold the controls. Logged rather than refused out loud, because
        // replying to a bot to say no is one more message it may answer.
        log.info("peer agent attempted a command", {
          channelId: this.channelId,
          authorId: message.author.id,
          command: parsed.command.name,
        });
        return;
      }
      await this.handleCommand(parsed.command, message);
      return;
    }

    // Ordinary conversation. Ignored entirely while asleep, per the brief.
    if (this.room.state === "asleep") {
      log.debug("ignoring chat while asleep", { channelId: this.channelId });
      return;
    }
    if (!parsed.text) return;

    if (author === "peer" && !(await this.spendPeerTurn(message))) return;

    await this.enqueue({
      text: parsed.text,
      authorId: message.author.id,
      messageId: message.id,
      author,
      ambient,
    });
  }


  /** How the status line describes the attention window. */
  private listeningText(): string {
    const seconds = this.deps.config.attentionWindowSeconds;
    if (seconds <= 0) return "off — mention me every time";
    if (!this.listening()) return `dormant — mention me, then I listen for ${seconds}s`;
    const left = Math.ceil(((this.attentionUntil ?? 0) - Date.now()) / 1000);
    return `yes — for another ${left}s unless we keep talking`;
  }

  /** Whether the room is currently listening to un-mentioned messages. */
  private listening(): boolean {
    if (this.deps.config.attentionWindowSeconds <= 0) return false;
    if (this.room.state === "asleep") return false;
    return this.attentionUntil !== null && Date.now() < this.attentionUntil;
  }

  /**
   * Opens or re-opens the attention window.
   *
   * Called when the bot is addressed and again after every reply it gives, so
   * the clock measures silence rather than time since the last mention. A turn
   * can take half a minute to come back; a window running from the mention would
   * be shut before the reply it was opened for had even arrived.
   */
  private openAttention(): void {
    this.attentionUntil = Date.now() + this.deps.config.attentionWindowSeconds * 1000;
  }

  /**
   * Takes one turn from the peer budget, or refuses and says why.
   *
   * Two agents that both answer when mentioned will answer each other for as
   * long as they are allowed to, and the cost of that lands on two people who
   * are probably asleep. The budget bounds it: a fixed number of peer turns,
   * refilled by any operator message. The room is not otherwise touched, so
   * humans carry on talking to a room that has stopped talking to a bot.
   */
  private async spendPeerTurn(message: DiscordMessage): Promise<boolean> {
    const limit = this.deps.config.peerTurnLimit;
    if (this.peerTurns >= limit) {
      log.warn("peer turn budget exhausted", {
        channelId: this.channelId,
        authorId: message.author.id,
        limit,
      });
      if (!this.peerLimitAnnounced) {
        this.peerLimitAnnounced = true;
        // Said once, and addressed to nobody: a mention here would restart the
        // exchange the budget just stopped.
        await this.say(
          `I have taken ${limit} turn(s) with another agent without a human speaking, so I have stopped there. Say anything and we will pick it back up.`,
        );
      }
      return false;
    }
    this.peerTurns += 1;
    log.info("peer agent turn", {
      channelId: this.channelId,
      authorId: message.author.id,
      used: this.peerTurns,
      limit,
    });
    return true;
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
      case "instructions":
        return this.say(this.instructionsText());
      case "accept-instructions":
        return this.acceptInstructions();
    }
  }

  // ---------------------------------------------------------------- commands

  /** What this conversation is pinned to, and whether the registry has moved. */
  private instructionsText(): string {
    const { repo, config } = this.deps;
    const keys = repo.roomInstructionKeys(this.guildId, this.channelId);
    if (keys.length === 0) return "This room loads no instructions.";

    const sessionId = this.room.session_id;
    if (config.driftPolicy === "off") {
      return [`**Pinning is off** (policy \`off\`), so these resolve live every turn:`, ...keys.map((k) => `- ${k}`)].join("\n");
    }
    if (!sessionId) {
      return ["**Not pinned yet** — this room has no conversation. Keys it will pin on the first turn:", ...keys.map((k) => `- ${k}`)].join("\n");
    }

    const pins = new Map(repo.instructionPins(this.guildId, this.channelId, sessionId).map((p) => [p.key, p]));
    if (pins.size === 0) {
      return ["**Not pinned yet** — pins are minted on this conversation's first turn. Keys:", ...keys.map((k) => `- ${k}`)].join("\n");
    }

    const lines = keys.map((key) => {
      const row = repo.resolveInstruction(key, this.guildId, this.channelId);
      const pin = pins.get(key);
      if (!pin) return `- \`${key}\` — added since minting, loaded live`;
      if (!row) return `- \`${key}\` — **gone from the registry**, pinned copy in use`;
      const live = hashBody(row.body);
      return live === pin.sha256
        ? `- \`${key}\` — ok, \`${pin.sha256.slice(0, 12)}\``
        : `- \`${key}\` — **drifted**, pinned \`${pin.sha256.slice(0, 12)}\` vs live \`${live.slice(0, 12)}\``;
    });

    return [
      `**Conversation** \`${sessionId}\`  **policy** \`${config.driftPolicy}\``,
      ...lines,
      `Run \`${this.mention} accept instructions\` to adopt the current versions.`,
    ].join("\n");
  }

  /**
   * Re-mints this conversation's pins from the registry as it stands now.
   *
   * The operator is adopting changes they already made deliberately; this only
   * decides which version a running conversation is held to. It authors nothing,
   * so it is a room control rather than a registry edit.
   */
  private async acceptInstructions(): Promise<void> {
    const { repo, config } = this.deps;
    if (config.driftPolicy === "off") {
      return this.say("Pinning is off in this deployment, so there is nothing to accept.");
    }
    const sessionId = this.room.session_id;
    if (!sessionId) {
      return this.say("There is no conversation to pin yet. Wake me and the first turn mints them.");
    }

    const keys = repo.roomInstructionKeys(this.guildId, this.channelId);
    const minted: Instruction[] = [];
    for (const key of keys) {
      const row = repo.resolveInstruction(key, this.guildId, this.channelId);
      if (row) minted.push({ key: row.key, scope: row.scope, body: row.body, sha256: hashBody(row.body) });
    }

    repo.pinInstructions(this.guildId, this.channelId, sessionId, minted);
    this.announcedDrift = null;
    log.info("instruction pins accepted", {
      channelId: this.channelId,
      sessionId,
      keys: minted.map((i) => i.key),
    });

    await this.say(
      minted.length === 0
        ? "Accepted: this room now pins nothing, because no key it loads resolves to anything."
        : `Accepted. This conversation is now pinned to ${minted.length} instruction(s): ${minted.map((i) => i.key).join(", ")}. It takes effect on the next turn.`,
    );
  }


  private statusText(): string {
    const room = this.room;
    const lines = [
      `**Room** ${room.state}${this.running ? " — working" : ""}`,
      `**Conversation** ${room.session_id ?? "none yet"}`,
      `**Model** ${room.model ?? this.deps.config.defaultModel ?? "runtime default"}`,
      `**Effort** ${room.effort ?? this.deps.config.defaultEffort ?? "runtime default"}`,
      `**Permissions** mode \`${this.deps.config.permissionMode}\`, prompts \`${this.deps.config.permissionPrompts}\``,
      `**Listening** ${this.listeningText()}`,
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
    this.lastHistoryId = null;

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
    this.lastHistoryId = null;
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
      // An ambient message queues in silence. Announcing it would be a reply
      // to something nobody established was addressed here, which is the one
      // thing ambient listening must not do.
      if (!turn.ambient) {
        await this.say(`Queued — I am working. ${this.queue.length} message(s) waiting.`, turn.messageId);
      }
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

  /**
   * The runtime authority a turn runs with, decided by who spoke.
   *
   * PERMISSION_MODE is a property of the service, not of the author, so widening
   * it would grant a peer agent exactly what an operator has - and a peer is a
   * bot on somebody else s machine, running somebody else s code. Peer turns run
   * at PEER_PERMISSION_MODE instead, which defaults to plan.
   *
   * Switching between the two restarts the runtime and resumes the same
   * conversation by id, which is the same mechanism a model or effort change
   * already uses. It costs a process start, and it is not optional.
   */
  private permissionModeFor(author: AuthorKind): string {
    return author === "peer"
      ? this.deps.config.peerPermissionMode
      : this.deps.config.permissionMode;
  }

  private async ensureSession(author: AuthorKind = "operator"): Promise<ClaudeSession> {
    const room = this.room;
    const model = room.model ?? this.deps.config.defaultModel;
    const effort = room.effort ?? this.deps.config.defaultEffort;
    const permissionMode = this.permissionModeFor(author);

    const settingsChanged =
      this.activeSettings !== null &&
      (this.activeSettings.model !== model ||
        this.activeSettings.effort !== effort ||
        this.activeSettings.permissionMode !== permissionMode);

    if (this.session?.isRunning && !settingsChanged) return this.session;

    if (this.session) {
      log.info("restarting runtime to apply new settings", { channelId: this.channelId, model, effort });
      await this.session.stop();
    }

    const sessionId = room.session_id ?? crypto.randomUUID();
    if (!room.session_id) this.deps.repo.setSession(this.guildId, this.channelId, sessionId);

    // The runtime rejects --session-id for an id it already knows, and --resume
    // for one it does not. The database remembers which applies, so this holds
    // across a service restart rather than only within one process.
    const resume = room.session_started === 1;

    const session = new ClaudeSession({
      bin: this.deps.config.claudeBin,
      cwd: this.deps.config.workspaceDir,
      sessionId,
      resume,
      model,
      effort,
      permissionMode,
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
    // The runtime registers the id as it starts, so from here on it must be
    // resumed rather than recreated.
    if (!resume) this.deps.repo.markSessionStarted(this.guildId, this.channelId);
    this.session = session;
    this.activeSettings = { model, effort, permissionMode };
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

      // Said before the turn runs, so the reader learns the rules moved before
      // they read an answer produced under them.
      if (built.notice) await this.say(built.notice);

      const session = await this.ensureSession(turn.author);
      const outcome = await session.runTurn(built.prompt);


      if (outcome.reason === "interrupted") {
        // Checked first, and deliberately. A task killed mid-sentence may have
        // already produced partial output; posting it after "Task interrupted"
        // contradicts the message the operator just read. Stop means stop.
      } else if (outcome.text?.trim() && turn.ambient && isDecline(outcome.text)) {
        // The runtime read the room and decided the message was not for it.
        // Nothing is posted, and the attention window is deliberately NOT
        // re-opened: nobody spoke to this bot, so the silence should still
        // count towards it falling dormant.
        log.debug("ambient message judged not for this bot", {
          channelId: this.channelId,
          messageId: turn.messageId,
        });
      } else if (outcome.text?.trim()) {
        // Answering is being in the conversation, so the window re-opens here
        // rather than only on a mention. A turn can take half a minute; a window
        // measured from the mention would shut before its own reply arrived.
        this.openAttention();
        // Addressed back to a peer so the reply reaches it. A peer that is
        // mention-gated - as this one is - hears nothing otherwise, and the
        // conversation ends after a single turn.
        await this.say(outcome.text.trim(), turn.messageId, turn.author === "peer" ? turn.authorId : null);
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
  /**
   * Resolves the instruction packet for this turn.
   *
   * Instructions are read on every turn, so an edit is visible immediately - but
   * a conversation that is already running is pinned, so the edit is reported
   * rather than applied underneath it. A conversation with no pins has never
   * been minted, and minting it is the first thing that happens here.
   */
  private renderInstructions(): { text: string; missing: string[]; notice: string | null } {
    const { repo, config } = this.deps;
    let keys = repo.roomInstructionKeys(this.guildId, this.channelId);

    // A room is created by the first message sent in it and declares no keys, so
    // a new channel arrives with no rules at all and nothing says so. Falling
    // back to the configured defaults is what stops a fresh room being a
    // different bot from every other one.
    if (keys.length === 0 && config.defaultInstructionKeys.length > 0) {
      keys = [...config.defaultInstructionKeys];
    }
    if (keys.length === 0) {
      log.warn("room loads no instructions", { channelId: this.channelId });
    }

    const live = new Map<string, Instruction>();
    for (const key of keys) {
      const row = repo.resolveInstruction(key, this.guildId, this.channelId);
      if (row) live.set(key, { key: row.key, scope: row.scope, body: row.body, sha256: hashBody(row.body) });
      else if (!repo.isRequired(key)) {
        log.warn("instruction key resolved to nothing", { key, channelId: this.channelId });
      }
    }

    const sessionId = this.room.session_id;
    const pinning = config.driftPolicy !== "off" && sessionId !== null;
    let pins = new Map<string, Instruction>();

    if (pinning) {
      const stored = repo.instructionPins(this.guildId, this.channelId, sessionId!);
      if (stored.length === 0 && live.size > 0) {
        // First turn of this conversation: mint what it is being told, so that
        // every later turn has something to have drifted from.
        const minted = keys.map((k) => live.get(k)).filter((i): i is Instruction => i !== undefined);
        repo.pinInstructions(this.guildId, this.channelId, sessionId!, minted);
        log.info("minted instruction pins", {
          channelId: this.channelId,
          sessionId,
          keys: minted.map((i) => i.key),
        });
        pins = new Map(minted.map((i) => [i.key, i]));
      } else {
        pins = new Map(stored.map((i) => [i.key, i]));
      }
    }

    const plan = planPacket({
      keys,
      live,
      pins,
      isRequired: (key) => repo.isRequired(key),
      policy: pinning ? config.driftPolicy : "off",
    });

    // Each distinct drift state is reported once. Repeating it every turn would
    // train the reader to skip it, which is the same as not saying it.
    let notice: string | null = null;
    const signature = plan.signature;
    if (signature !== this.announcedDrift) {
      this.announcedDrift = signature;
      notice = driftNotice(plan, config.driftPolicy, this.mention);
      if (notice) {
        log.info("instruction drift", {
          channelId: this.channelId,
          drifted: plan.drifted,
          vanished: plan.vanished,
          policy: config.driftPolicy,
        });
      }
    }

    return { text: renderPacket(plan.use), missing: plan.missing, notice };
  }

  /**
   * Builds the turn text: instructions on every turn, channel history once, then
   * the operator's own message.
   */
  private async buildPrompt(
    turn: PendingTurn,
  ): Promise<{ prompt: string; notice: string | null } | { error: string }> {
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

    // Every turn carries what has been said since the last one, not just the
    // first. A conversation the bot cannot see is a conversation it cannot
    // follow, and judging whether an un-mentioned message was meant for it is
    // exactly a question about what came before.
    const messages = await fetchHistory(this.deps.rest, this.channelId, {
      limit: this.deps.config.historyLimit,
      excludeId: turn.messageId,
      ...(this.lastHistoryId ? { afterId: this.lastHistoryId } : {}),
    });
    const history = renderHistory(messages, this.lastHistoryId !== null);
    if (history) parts.push(history);
    this.lastHistoryId = turn.messageId;

    parts.push(turn.ambient ? ambientPreamble(turn.text) : turn.text);
    return { prompt: parts.join("\n\n"), notice: instructions.notice };
  }

  async shutdown(): Promise<void> {
    this.queue = [];
    await this.session?.stop();
    this.session = null;
  }
}
