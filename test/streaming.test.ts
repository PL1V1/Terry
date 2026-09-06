/**
 * A reply that grows in place.
 *
 * For a minute at a time the room used to show nothing, and nothing looks the
 * same whether the bot is working or dead. These tests hold the feature to the
 * spec it was built from: a placeholder within a moment, edits that coalesce,
 * overflow that never breaks a code fence, a footer that says what it cost, and
 * an interruption that leaves nothing partial on screen.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import { footerFor, INTERRUPTED, PLACEHOLDER, splitForOverflow, tickerFor } from "../src/controller/stream.ts";
import { MAX_MESSAGE, type MessageTransport, type SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import { FAKE_BIN } from "./acceptance.test.ts";

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
const PEER = "222222222222222222";
const GUILD = "444444444444444444";
const CHANNEL = "555555555555555555";

/** The stub's help, plus the flag streaming depends on. */
const HELP_STREAMING = `Options:
  --effort <level>       Effort level (low, medium, high, xhigh, max)
  --model <model>        Provide an alias (e.g. 'fable', 'opus', or 'sonnet')
  --permission-mode <m>  mode (choices: "acceptEdits", "plan")
  --permission-prompts <t>  target (choices: "host", "none")
  --include-partial-messages  Include partial message chunks as they arrive
  -p, --print            Print response and exit
  --input-format <f>     Input format (choices: "text", "stream-json")
  --output-format <f>    Output format (choices: "text", "stream-json")
  --session-id <uuid>    Use a specific session ID
  -r, --resume [value]   Resume a conversation
`;
const HELP_PLAIN = HELP_STREAMING.replace(/^.*--include-partial-messages.*\n/m, "");

// ----------------------------------------------------------- pure pieces

describe("streaming - the ticker", () => {
  test("file tools name the file", () => {
    expect(tickerFor("Read", { file_path: "src/auth.ts" })).toBe("reading src/auth.ts");
    expect(tickerFor("Edit", { file_path: "src/auth.ts" })).toBe("editing src/auth.ts");
  });

  test("a shell shows the start of the command", () => {
    expect(tickerFor("Bash", { command: "bun test" })).toBe("running bun test");
    const long = tickerFor("Bash", { command: "x".repeat(200) });
    expect(long.length).toBeLessThanOrEqual("running ".length + 60);
    expect(long.endsWith("…")).toBe(true);
  });

  test("an unknown tool shows its name", () => {
    expect(tickerFor("Frobnicate", {})).toBe("frobnicate");
  });
});

describe("streaming - the footer", () => {
  test("says elapsed, tokens and cost", () => {
    expect(footerFor(47_000, { inputTokens: 6, cachedInputTokens: 45_000, outputTokens: 2_000, costUsd: 0.18, durationMs: null })).toBe(
      "-# 47 s · 6 in + 45k cached / 2k out · $0.18",
    );
  });

  test("leaves out what the runtime did not report", () => {
    expect(footerFor(3_000)).toBe("-# 3 s");
    expect(footerFor(3_000, { inputTokens: null, cachedInputTokens: null, outputTokens: null, costUsd: null, durationMs: null })).toBe("-# 3 s");
    // Nothing came from cache: no "+ 0 cached" noise.
    expect(footerFor(3_000, { inputTokens: 900, cachedInputTokens: 0, outputTokens: 10, costUsd: null, durationMs: null })).toBe("-# 3 s · 900 in / 10 out");
  });
});

describe("streaming - overflow splitting", () => {
  test("splits at a paragraph boundary", () => {
    const text = "one\n\ntwo\n\nthree";
    const { head, tail } = splitForOverflow(text, 10);
    expect(head).toBe("one\n\ntwo");
    expect(tail).toBe("three");
  });

  test("a code block cut in half is closed and reopened", () => {
    const text = "```ts\n" + "a\n".repeat(20) + "```";
    const { head, tail } = splitForOverflow(text, 20);
    expect((head.match(/```/g) ?? []).length % 2).toBe(0);
    expect((tail.match(/```/g) ?? []).length % 2).toBe(0);
  });

  test("text that fits is returned whole", () => {
    expect(splitForOverflow("short", 100)).toEqual({ head: "short", tail: "" });
  });
});

// ------------------------------------------------------------- the room

interface Op {
  kind: "send" | "edit";
  id: string;
  text: string;
  at: number;
  allowMentions?: boolean;
}

class Recorder implements MessageTransport {
  readonly ops: Op[] = [];
  private next = 0;
  readonly canEdit: boolean;

  constructor(canEdit = true) {
    this.canEdit = canEdit;
    if (!canEdit) (this as { editMessage?: unknown }).editMessage = undefined;
  }

  async sendMessage(channelId: string, text: string, options: { allowMentions?: boolean } = {}): Promise<SentMessage[]> {
    this.next += 1;
    const id = `m${this.next}`;
    this.ops.push({ kind: "send", id, text, at: Date.now(), allowMentions: options.allowMentions });
    return [{ id, channel_id: channelId }];
  }

  async editMessage(_channelId: string, messageId: string, text: string): Promise<void> {
    this.ops.push({ kind: "edit", id: messageId, text, at: Date.now() });
  }

  async recentMessages(): Promise<unknown[]> {
    return [];
  }

  /** The last content each message id was left with, in the order they were created. */
  finalMessages(): string[] {
    const last = new Map<string, string>();
    for (const op of this.ops) last.set(op.id, op.text);
    return [...last.values()];
  }

  sends(): Op[] {
    return this.ops.filter((o) => o.kind === "send");
  }

  edits(): Op[] {
    return this.ops.filter((o) => o.kind === "edit");
  }
}

let counter = 0;

function room(env: Record<string, string> = {}, help = HELP_STREAMING, transport = new Recorder()) {
  const config = loadConfig({
    CLAUDE_BIN: FAKE_BIN,
    DISCORD_TOKEN: "a-token-value-long-enough",
    DISCORD_APPLICATION_ID: BOT,
    ALLOWED_CHANNELS: CHANNEL,
    OPERATORS: OPERATOR,
    ALLOWED_GUILDS: GUILD,
    PEER_AGENTS: PEER,
    HISTORY_LIMIT: "0",
    STREAM_EDIT_INTERVAL_MS: "40",
    ...env,
  });
  const db = new Database(":memory:");
  migrateUp(db);
  const controller = new RoomController(
    {
      config,
      repo: new Repo(db),
      rest: transport,
      caps: parseCapabilities(help, "2.1.263"),
      botId: BOT,
      botName: "Terry",
      selfMentionIds: () => new Set([BOT]),
      onActivity: () => {},
    },
    GUILD,
    CHANNEL,
  );
  const send = async (text: string, who: "operator" | "peer", mention = true): Promise<void> => {
    counter += 1;
    await controller.handleMessage(
      {
        id: String(720000000000000000n + BigInt(counter)),
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: mention ? `<@${BOT}> ${text}` : text,
        author: { id: who === "peer" ? PEER : OPERATOR, username: "x", ...(who === "peer" ? { bot: true } : {}) },
        timestamp: new Date().toISOString(),
      } satisfies DiscordMessage,
      who,
    );
  };
  return {
    transport,
    at: (text: string) => send(text, "operator"),
    overheard: (text: string) => send(text, "operator", false),
    fromPeer: (text: string) => send(text, "peer"),
  };
}

describe("streaming - a reply that grows in place", () => {
  test("a placeholder is posted first, then edited into the answer", async () => {
    const h = room();
    await h.at("wakeup");
    const mark = h.transport.ops.length;
    await h.at("__STREAM__");

    const ops = h.transport.ops.slice(mark);
    expect(ops[0]!.kind).toBe("send");
    expect(ops[0]!.text).toContain(PLACEHOLDER);

    const edits = ops.filter((o) => o.kind === "edit" && o.id === ops[0]!.id);
    expect(edits.length).toBeGreaterThan(0);
    const last = edits.at(-1)!.text;
    expect(last).toContain("Streamed reply: all done, guv.");
    expect(last).not.toContain(PLACEHOLDER);
  });

  test("the final edit carries the footer", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("__STREAM__");
    const finals = h.transport.finalMessages();
    expect(finals.at(-1)).toContain("6 in + 31k cached / 2k out · $0.18");
  });

  test("the ticker names what the runtime is doing", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("__TOOLS__");
    const seen = h.transport.edits().some((e) => e.text.includes("reading src/auth.ts"));
    expect(seen).toBe(true);
  });

  test("edits are coalesced, so a fast turn does not flood", async () => {
    const h = room({ STREAM_EDIT_INTERVAL_MS: "200" });
    await h.at("wakeup");
    const started = Date.now();
    await h.at("__STREAM__");
    const elapsed = Date.now() - started;
    // The spec's bound: elapsed / interval, plus the placeholder edit and the final.
    expect(h.transport.edits().length).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 2);
  });

  test("a long reply overflows into continuation messages, none over the limit", async () => {
    const h = room();
    await h.at("wakeup");
    const mark = h.transport.sends().length;
    await h.at("__LONG__");

    const finals = h.transport.finalMessages().slice(mark);
    expect(finals.length).toBeGreaterThanOrEqual(2);
    for (const text of finals) {
      expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE);
      // A code block split across messages is closed on one side and reopened on the other.
      expect((text.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(finals.join("\n")).toContain("The end.");
    expect(finals.at(-1)).toContain("$0.18");
  });

  test("interrupting mid-stream leaves only 'Task interrupted.' on screen", async () => {
    const h = room();
    await h.at("wakeup");
    const mark = h.transport.sends().length;

    const turn = h.at("__STREAM_HANG__");
    // Let some text stream, then pull the plug.
    await Bun.sleep(400);
    await h.at("stop");
    await turn;

    const streamed = h.transport.finalMessages().slice(mark);
    const placeholderMessage = streamed[0]!;
    expect(placeholderMessage).toBe(INTERRUPTED);
    expect(placeholderMessage).not.toContain("quick brown fox");
  });
});

describe("streaming - who does not get it", () => {
  test("a peer's turn is posted whole with the mention, not streamed", async () => {
    const h = room();
    await h.at("wakeup");
    const mark = h.transport.ops.length;
    await h.fromPeer("__STREAM__");

    const ops = h.transport.ops.slice(mark);
    expect(ops.filter((o) => o.kind === "edit")).toHaveLength(0);
    const reply = ops.find((o) => o.kind === "send")!;
    expect(reply.text).toContain(`<@${PEER}>`);
    expect(reply.allowMentions).toBe(true);
    expect(reply.text).not.toContain(PLACEHOLDER);
  });

  test("an overheard message is never given a placeholder", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("hello");
    const mark = h.transport.ops.length;
    await h.overheard("__STREAM__");

    const ops = h.transport.ops.slice(mark);
    expect(ops.some((o) => o.text.includes(PLACEHOLDER))).toBe(false);
    expect(ops.filter((o) => o.kind === "edit")).toHaveLength(0);
  });

  test("STREAMING=off restores post-at-end", async () => {
    const h = room({ STREAMING: "off" });
    await h.at("wakeup");
    const mark = h.transport.ops.length;
    await h.at("__STREAM__");
    const ops = h.transport.ops.slice(mark);
    expect(ops.filter((o) => o.kind === "edit")).toHaveLength(0);
    expect(ops.some((o) => o.text.includes("all done, guv"))).toBe(true);
  });

  test("a runtime that cannot stream gets post-at-end, not a broken placeholder", async () => {
    const h = room({}, HELP_PLAIN);
    await h.at("wakeup");
    const mark = h.transport.ops.length;
    await h.at("__STREAM__");
    const ops = h.transport.ops.slice(mark);
    expect(ops.filter((o) => o.kind === "edit")).toHaveLength(0);
    expect(ops.some((o) => o.text.includes(PLACEHOLDER))).toBe(false);
  });

  test("a transport that cannot edit gets post-at-end", async () => {
    const h = room({}, HELP_STREAMING, new Recorder(false));
    await h.at("wakeup");
    const mark = h.transport.ops.length;
    await h.at("__STREAM__");
    const ops = h.transport.ops.slice(mark);
    expect(ops.some((o) => o.text.includes(PLACEHOLDER))).toBe(false);
    expect(ops.some((o) => o.text.includes("all done, guv"))).toBe(true);
  });
});
