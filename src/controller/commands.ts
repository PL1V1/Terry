export type CommandName =
  | "menu"
  | "wakeup"
  | "sleep"
  | "stop"
  | "status"
  | "ping"
  | "list-models"
  | "model"
  | "effort"
  | "new-session"
  | "confirm-new-session"
  | "activity"
  | "instructions"
  | "accept-instructions";

export interface ParsedCommand {
  name: CommandName;
  /** The argument text, empty when the command takes none. */
  arg: string;
}

export interface ParsedInput {
  /** True when the bot was addressed directly. */
  mentioned: boolean;
  /** A deterministic command, when the text is one. */
  command: ParsedCommand | null;
  /** The message with the leading bot mention removed. */
  text: string;
}

// <@id> is a user mention, <@!id> a nickname mention, <@&id> a ROLE mention.
// Discord creates a managed role named after a bot when it is invited, and its
// autocomplete offers that role alongside the bot user. Both render as the same
// "@Name" on screen, so refusing the role form just makes the bot look broken.
const MENTION = /^\s*<@[!&]?(\d+)>\s*/;

/**
 * Parses one Discord message.
 *
 * Commands are matched only when the bot is addressed directly, so ordinary
 * conversation that happens to contain the word "sleep" is never treated as an
 * instruction to the service.
 *
 * `self` is every id that counts as addressing this bot: its user id, plus the
 * ids of the managed roles Discord created for it. Only those are accepted, so a
 * mention of some other role is still ordinary chat.
 */
export function parseInput(content: string, self: string | ReadonlySet<string>): ParsedInput {
  const selfIds = typeof self === "string" ? new Set([self]) : self;
  let text = content ?? "";
  let mentioned = false;

  const match = MENTION.exec(text);
  if (match && selfIds.has(match[1]!)) {
    mentioned = true;
    text = text.slice(match[0].length);
  }

  return { mentioned, command: mentioned ? parseCommand(text) : null, text: text.trim() };
}

/** Recognises the deterministic command vocabulary. Case-insensitive. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Two-word commands are checked first so "new session" is not read as "new".
  if (lower === "new session") return { name: "new-session", arg: "" };
  if (lower === "new session confirm" || lower === "confirm new session") {
    return { name: "confirm-new-session", arg: "" };
  }
  if (lower === "list models" || lower === "models") return { name: "list-models", arg: "" };
  if (lower === "accept instructions" || lower === "instructions accept") {
    return { name: "accept-instructions", arg: "" };
  }
  if (lower === "instructions") return { name: "instructions", arg: "" };

  const [word, ...rest] = trimmed.split(/\s+/);
  const head = (word ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  switch (head) {
    case "menu":
    case "help":
      return { name: "menu", arg: "" };
    case "wakeup":
    case "wake":
      return { name: "wakeup", arg: "" };
    case "sleep":
      return { name: "sleep", arg: "" };
    case "stop":
      return { name: "stop", arg: "" };
    case "status":
      return { name: "status", arg: "" };
    case "ping":
      return { name: "ping", arg: "" };
    case "model":
      return { name: "model", arg };
    case "effort":
      return { name: "effort", arg };
    case "activity":
      return { name: "activity", arg };
    default:
      return null;
  }
}

/**
 * `botLabel` is a readable name such as "@Terry", not a raw <@id> mention:
 * Discord does not render mentions inside code spans, so an id would appear to
 * the reader as literal angle brackets and numbers.
 */
export function menuText(botLabel: string): string {
  return [
    "**Commands** — all of these work whether I am awake or asleep.",
    "",
    `\`${botLabel} wakeup\` — start or resume this room's conversation`,
    `\`${botLabel} sleep\` — interrupt work, drop pending input, stop taking chat`,
    `\`${botLabel} stop\` — interrupt the current task but stay awake`,
    `\`${botLabel} status\` — readiness, model, effort, and whether work is running`,
    `\`${botLabel} ping\` — connection check`,
    "",
    `\`${botLabel} list models\` — models the runtime reports`,
    `\`${botLabel} model <id>\` — choose a model, e.g. \`model opus\``,
    `\`${botLabel} effort\` — effort levels this model supports`,
    `\`${botLabel} effort <level>\` — choose one, e.g. \`effort high\``,
    "",
    `\`${botLabel} instructions\` — which instructions this conversation is pinned to`,
    `\`${botLabel} accept instructions\` — adopt the current versions from the registry`,
    "",
    `\`${botLabel} new session\` — replace this room's conversation (asks first)`,
    `\`${botLabel} activity <text>\` — set the presence text`,
    `\`${botLabel} activity auto\` — go back to automatic presence text`,
    "",
    "Model and effort changes apply to the next turn, not to work already running.",
  ].join("\n");
}
