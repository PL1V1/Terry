/**
 * A reply that grows in place.
 *
 * A turn can take a minute, and for that minute the room used to show nothing:
 * no way to tell a bot that is working from one that has died. Now a
 * placeholder is posted the moment the turn starts and edited as text arrives,
 * with a ticker line saying what the runtime is doing, and a footer at the end
 * saying what it cost.
 *
 * Discord rate-limits edits harder than sends, so edits are coalesced onto a
 * trailing timer and an edit whose content matches the last one is skipped.
 * Every write goes through one promise chain, so edits can never arrive out of
 * order however fast the deltas come.
 */
import { MAX_MESSAGE, type MessageTransport } from "../discord/rest.ts";
import type { TurnUsage } from "../runtime/claude.ts";
import { log } from "../log.ts";

export const PLACEHOLDER = "Working…";
export const INTERRUPTED = "Task interrupted.";

/**
 * What the ticker says for a tool call: the verb, and the most identifying
 * input. A file path for file tools, the start of the command for a shell,
 * the pattern for a search. Unknown tools show their name.
 */
export function tickerFor(name: string, input: Record<string, unknown>): string {
  const str = (key: string): string | null => {
    const v = input[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const path = str("file_path") ?? str("path") ?? str("notebook_path");

  switch (name) {
    case "Read":
      return path ? `reading ${clip(path)}` : "reading";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return path ? `editing ${clip(path)}` : "editing";
    case "Bash":
    case "PowerShell": {
      const cmd = str("command");
      return cmd ? `running ${clip(cmd.replace(/\s+/g, " "))}` : "running a command";
    }
    case "Grep":
    case "Glob": {
      const pattern = str("pattern");
      return pattern ? `searching for ${clip(pattern)}` : "searching";
    }
    case "WebFetch":
    case "WebSearch":
      return "looking something up";
    case "Agent":
    case "Task":
      return "delegating";
    default:
      return name.toLowerCase();
  }
}

/**
 * `47 s · 6 in + 45k cached / 2k out · $0.18`, with whatever the runtime reported.
 *
 * The cached figure matters: on a long conversation nearly everything the model
 * read came from cache, and a footer showing only the fresh input next to the
 * cost looks like it is lying.
 */
export function footerFor(elapsedMs: number, usage?: TurnUsage): string {
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  const parts = [`${secs} s`];
  if (usage && (usage.inputTokens !== null || usage.outputTokens !== null)) {
    const k = (n: number | null): string => (n === null ? "?" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const cached = usage.cachedInputTokens ? ` + ${k(usage.cachedInputTokens)} cached` : "";
    parts.push(`${k(usage.inputTokens)} in${cached} / ${k(usage.outputTokens)} out`);
  }
  if (usage?.costUsd !== null && usage?.costUsd !== undefined) {
    parts.push(`$${usage.costUsd.toFixed(2)}`);
  }
  return `-# ${parts.join(" · ")}`;
}

/**
 * Splits text so the head fits a limit, at the last paragraph boundary it can
 * find. A code block cut in half is closed at the end of the head and reopened
 * at the start of the tail, so neither piece renders as a wall of backticks.
 */
export function splitForOverflow(text: string, limit: number): { head: string; tail: string } {
  if (text.length <= limit) return { head: text, tail: "" };
  let cut = text.lastIndexOf("\n\n", limit);
  if (cut < limit / 4) cut = text.lastIndexOf("\n", limit);
  if (cut < limit / 4) cut = limit;
  let head = text.slice(0, cut);
  let tail = text.slice(cut).replace(/^\s+/, "");
  const fences = (head.match(/```/g) ?? []).length;
  if (fences % 2 === 1) {
    head = `${head}\n\`\`\``;
    tail = `\`\`\`\n${tail}`;
  }
  return { head, tail };
}

export class StreamedReply {
  /** Text of the message currently being edited. Earlier overflow messages are frozen. */
  private live = "";
  private tickerLine: string | null = PLACEHOLDER;
  private messageId: string | null = null;
  private lastSent = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  /** How many edits actually went out, so a test can bound them. */
  edits = 0;
  /** Message ids in order: the first, then each overflow continuation. */
  readonly messageIds: string[] = [];
  /** Text already frozen into earlier overflow messages, so the final text can be split to match. */
  private frozenPrefix = "";

  constructor(
    private readonly transport: MessageTransport,
    private readonly channelId: string,
    private readonly replyTo: string | undefined,
    private readonly intervalMs: number,
  ) {}

  /** Posts the placeholder. Nothing else happens until this has. */
  async open(): Promise<void> {
    const content = this.render();
    const [sent] = await this.transport.sendMessage(this.channelId, content, this.replyTo ? { replyTo: this.replyTo } : {});
    if (!sent) throw new Error("placeholder was not posted");
    this.messageId = sent.id;
    this.messageIds.push(sent.id);
    this.lastSent = content;
  }

  ticker(line: string): void {
    if (this.closed) return;
    this.tickerLine = line;
    this.schedule();
  }

  append(text: string): void {
    if (this.closed) return;
    this.live += text;
    this.schedule();
  }

  /** The turn is over: the final text replaces what was streamed, and the footer goes under it. */
  async finish(finalText: string, footer: string): Promise<void> {
    await this.settle();
    this.tickerLine = null;
    // What was streamed and what the runtime returns are the same text in the
    // common case, but the result is authoritative. Overflow already frozen
    // into earlier messages is kept; only the live message is replaced.
    this.live = this.replaceLive(finalText);
    this.live = this.live ? `${this.live}\n\n${footer}` : footer;
    await this.push(true);
    this.closed = true;
  }

  /** The turn failed: the live message says so, and nothing partial stays on screen. */
  async fail(text: string): Promise<void> {
    await this.settle();
    this.tickerLine = null;
    this.live = text;
    await this.push(true);
    this.closed = true;
  }

  async interrupted(): Promise<void> {
    await this.fail(INTERRUPTED);
  }

  /**
   * The turn turned out not to be for us: the placeholder, and any overflow it
   * grew into, is deleted rather than left as a reply to a message nobody
   * established was addressed here.
   */
  async discard(): Promise<void> {
    await this.settle();
    this.closed = true;
    if (!this.transport.deleteMessage) return;
    for (const id of this.messageIds) {
      try {
        await this.transport.deleteMessage(this.channelId, id);
      } catch (error) {
        log.warn("could not delete a discarded placeholder", { channelId: this.channelId, messageId: id, error });
      }
    }
  }

  // ------------------------------------------------------------ internals

  private render(): string {
    if (this.tickerLine && this.live) return `-# ${this.tickerLine}\n\n${this.live}`;
    if (this.tickerLine) return `-# ${this.tickerLine}`;
    return this.live;
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push(false);
    }, this.intervalMs);
  }

  /** Waits for the pending timer and every write in flight. */
  private async settle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.chain;
  }

  /**
   * Given the authoritative final text, returns the part that belongs in the
   * live message. Text already frozen into earlier messages is a prefix of it
   * in the common case; when it is not - the runtime restated something - the
   * whole final text goes live, and the earlier messages stand as the record of
   * what was shown while it worked.
   */
  private replaceLive(finalText: string): string {
    if (this.messageIds.length <= 1) return finalText;
    const frozen = this.frozenPrefix;
    return finalText.startsWith(frozen) ? finalText.slice(frozen.length).replace(/^\s+/, "") : finalText;
  }


  private push(final: boolean): Promise<void> {
    this.chain = this.chain.then(() => this.write(final)).catch((error) => {
      log.warn("streaming edit failed", { channelId: this.channelId, error });
    });
    return this.chain;
  }

  private async write(final: boolean): Promise<void> {
    if (!this.messageId || !this.transport.editMessage) return;

    // Overflow: freeze what fits into the current message and carry the rest
    // into a new one, as many times as it takes.
    while (this.render().length > MAX_MESSAGE) {
      const allowance = this.tickerLine ? MAX_MESSAGE - this.tickerLine.length - 6 : MAX_MESSAGE;
      const { head, tail } = splitForOverflow(this.live, allowance);
      if (!tail) break;
      await this.transport.editMessage(this.channelId, this.messageId, head);
      this.edits += 1;
      this.frozenPrefix += head;
      this.live = tail;
      const [next] = await this.transport.sendMessage(this.channelId, this.render());
      if (!next) return;
      this.messageId = next.id;
      this.messageIds.push(next.id);
      this.lastSent = this.render();
    }

    const content = this.render();
    if (content === this.lastSent) return;
    if (!content.trim() && !final) return;
    await this.transport.editMessage(this.channelId, this.messageId, content);
    this.edits += 1;
    this.lastSent = content;
  }
}
