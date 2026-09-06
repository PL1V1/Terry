/**
 * Being addressed, wherever the name lands.
 *
 * The parser only counted a mention at the very start of a message. People
 * write "morning @Terry, how's it going" far more often than they lead with the
 * name, and a message that said the bot's name and was dropped as "not
 * addressed" is the worst kind of silent - it happened to a real person on the
 * first evening, and the log said nothing because the drop was at debug.
 *
 * And an overheard turn now streams like any other, with its placeholder taken
 * back if the runtime decides the message was not for us.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseInput } from "../src/controller/commands.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import { PLACEHOLDER } from "../src/controller/stream.ts";
import type { MessageTransport, SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import { FAKE_BIN } from "./acceptance.test.ts";

const BOT = "111111111111111111";
const ROLE = "999999999999999999";
const OTHER = "333333333333333333";
const OPERATOR = "777777777777777777";
const GUILD = "444444444444444444";
const CHANNEL = "555555555555555555";
const SELF = new Set([BOT, ROLE]);

describe("a mention anywhere counts", () => {
  test("leading, as before", () => {
    const p = parseInput(`<@${BOT}> wakeup`, SELF);
    expect(p.mentioned).toBe(true);
    expect(p.command?.name).toBe("wakeup");
  });

  test("mid-sentence", () => {
    const p = parseInput(`Sapnin <@${BOT}> how's it going`, SELF);
    expect(p.mentioned).toBe(true);
    expect(p.command).toBeNull();
    expect(p.text).toBe("Sapnin how's it going");
  });

  test("at the end", () => {
    const p = parseInput(`what do you reckon <@${BOT}>`, SELF);
    expect(p.mentioned).toBe(true);
    expect(p.text).toBe("what do you reckon");
  });

  test("the managed role, anywhere", () => {
    expect(parseInput(`oi <@&${ROLE}> status`, SELF).mentioned).toBe(true);
  });

  test("a command after a trailing mention is still a command", () => {
    const p = parseInput(`status <@${BOT}>`, SELF);
    expect(p.command?.name).toBe("status");
  });

  test("somebody else's mention is not ours", () => {
    const p = parseInput(`hey <@${OTHER}> did you see this`, SELF);
    expect(p.mentioned).toBe(false);
    expect(p.text).toContain(`<@${OTHER}>`);
  });

  test("only the first self-mention is removed", () => {
    const p = parseInput(`<@${BOT}> tell <@${BOT}> a joke`, SELF);
    expect(p.mentioned).toBe(true);
    expect(p.text).toBe(`tell <@${BOT}> a joke`);
  });
});

// ---------------------------------------------------------------- the room

interface Op {
  kind: "send" | "edit" | "delete";
  id: string;
  text: string;
}

class Recorder implements MessageTransport {
  readonly ops: Op[] = [];
  private next = 0;
  async sendMessage(channelId: string, text: string): Promise<SentMessage[]> {
    this.next += 1;
    const id = `m${this.next}`;
    this.ops.push({ kind: "send", id, text });
    return [{ id, channel_id: channelId }];
  }
  async editMessage(_c: string, id: string, text: string): Promise<void> {
    this.ops.push({ kind: "edit", id, text });
  }
  async deleteMessage(_c: string, id: string): Promise<void> {
    this.ops.push({ kind: "delete", id, text: "" });
  }
  async recentMessages(): Promise<unknown[]> {
    return [];
  }
  /** Messages still on screen: sent and not since deleted, with their last content. */
  visible(): string[] {
    const last = new Map<string, string>();
    for (const op of this.ops) {
      if (op.kind === "delete") last.delete(op.id);
      else last.set(op.id, op.text);
    }
    return [...last.values()];
  }
}

const HELP = `Options:
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

let counter = 0;

function room() {
  const config = loadConfig({
    CLAUDE_BIN: FAKE_BIN,
    DISCORD_TOKEN: "a-token-value-long-enough",
    DISCORD_APPLICATION_ID: BOT,
    ALLOWED_CHANNELS: CHANNEL,
    OPERATORS: OPERATOR,
    ALLOWED_GUILDS: GUILD,
    HISTORY_LIMIT: "0",
    STREAM_EDIT_INTERVAL_MS: "40",
  });
  const db = new Database(":memory:");
  migrateUp(db);
  const transport = new Recorder();
  const controller = new RoomController(
    {
      config,
      repo: new Repo(db),
      rest: transport,
      caps: parseCapabilities(HELP, "2.1.263"),
      botId: BOT,
      botName: "Terry",
      selfMentionIds: () => SELF,
      onActivity: () => {},
    },
    GUILD,
    CHANNEL,
  );
  const send = async (content: string): Promise<void> => {
    counter += 1;
    await controller.handleMessage(
      {
        id: String(750000000000000000n + BigInt(counter)),
        channel_id: CHANNEL,
        guild_id: GUILD,
        content,
        author: { id: OPERATOR, username: "eef" },
        timestamp: new Date().toISOString(),
      } satisfies DiscordMessage,
      "operator",
    );
  };
  return { transport, send };
}

describe("a mid-sentence mention reaches the runtime", () => {
  test("the way a real one was dropped", async () => {
    const h = room();
    await h.send(`<@${BOT}> wakeup`);
    const before = h.transport.ops.length;
    await h.send(`Sapnin <@${BOT}> how's it going`);
    const said = h.transport.ops.slice(before).map((o) => o.text).join("\n");
    expect(said).toContain("echo: Sapnin how's it going");
  });
});

describe("an overheard turn streams too", () => {
  test("it gets a placeholder like any other turn", async () => {
    const h = room();
    await h.send(`<@${BOT}> wakeup`);
    await h.send(`<@${BOT}> hello`);
    const before = h.transport.ops.length;
    await h.send("and what about the other thing?");
    const ops = h.transport.ops.slice(before);
    expect(ops[0]!.kind).toBe("send");
    expect(ops[0]!.text).toContain(PLACEHOLDER);
    expect(h.transport.visible().at(-1)).toContain("echo: and what about the other thing?");
  });

  test("a declined one leaves nothing on screen", async () => {
    const h = room();
    await h.send(`<@${BOT}> wakeup`);
    await h.send(`<@${BOT}> hello`);
    const visibleBefore = h.transport.visible().length;
    await h.send("__DECLINE__ eef did you see the game");
    // The placeholder went up, and came back down.
    expect(h.transport.ops.some((o) => o.kind === "delete")).toBe(true);
    expect(h.transport.visible().length).toBe(visibleBefore);
    expect(h.transport.visible().join("\n")).not.toContain(PLACEHOLDER);
  });
});
