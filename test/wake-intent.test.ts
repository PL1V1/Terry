/**
 * `wakeup: <text>` - wake the room and ask it something, in one message.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseCommand } from "../src/controller/commands.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import type { MessageTransport, SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import { FAKE_BIN } from "./acceptance.test.ts";

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
const GUILD = "444444444444444444";
const CHANNEL = "555555555555555555";

const HELP = `Options:
  --effort <level>       Effort level (low, medium, high, xhigh, max)
  --model <model>        Provide an alias (e.g. 'fable', 'opus', or 'sonnet')
  --permission-mode <m>  mode (choices: "acceptEdits", "plan")
  --permission-prompts <t>  target (choices: "host", "none")
  -p, --print            Print response and exit
  --input-format <f>     Input format (choices: "text", "stream-json")
  --output-format <f>    Output format (choices: "text", "stream-json")
  --session-id <uuid>    Use a specific session ID
  -r, --resume [value]   Resume a conversation
`;

describe("wakeup: <text> - parsing", () => {
  test("a colon carries the first turn", () => {
    expect(parseCommand("wakeup: fix the build")).toEqual({ name: "wakeup", arg: "fix the build" });
  });

  test("the short form works too, with or without a space", () => {
    expect(parseCommand("wake: hello")).toEqual({ name: "wakeup", arg: "hello" });
    expect(parseCommand("wake:hello")).toEqual({ name: "wakeup", arg: "hello" });
  });

  test("case does not matter, and neither does trailing whitespace", () => {
    expect(parseCommand("WAKEUP:   Hello there  ")).toEqual({ name: "wakeup", arg: "Hello there" });
  });

  test("a bare wakeup is unchanged", () => {
    expect(parseCommand("wakeup")).toEqual({ name: "wakeup", arg: "" });
    expect(parseCommand("wake")).toEqual({ name: "wakeup", arg: "" });
  });

  test("a colon with nothing after it is just a wakeup", () => {
    expect(parseCommand("wakeup:")).toEqual({ name: "wakeup", arg: "" });
  });

  test("the text may itself contain colons and newlines", () => {
    expect(parseCommand("wakeup: note: line one\nline two")).toEqual({
      name: "wakeup",
      arg: "note: line one\nline two",
    });
  });
});

class Recorder implements MessageTransport {
  readonly sent: string[] = [];
  async sendMessage(channelId: string, text: string): Promise<SentMessage[]> {
    this.sent.push(text);
    return [{ id: `s${this.sent.length}`, channel_id: channelId }];
  }
  async recentMessages(): Promise<unknown[]> {
    return [];
  }
  since(n: number): string {
    return this.sent.slice(n).join("\n---\n");
  }
}

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
  });
  const db = new Database(":memory:");
  migrateUp(db);
  const repo = new Repo(db);
  const transport = new Recorder();
  const controller = new RoomController(
    {
      config,
      repo,
      rest: transport,
      caps: parseCapabilities(HELP, "2.1.263"),
      botId: BOT,
      botName: "Terry",
      selfMentionIds: () => new Set([BOT]),
      onActivity: () => {},
    },
    GUILD,
    CHANNEL,
  );
  return {
    repo,
    transport,
    state: () => repo.getRoom(GUILD, CHANNEL)?.state,
    async at(text: string): Promise<void> {
      counter += 1;
      await controller.handleMessage(
        {
          id: String(710000000000000000n + BigInt(counter)),
          channel_id: CHANNEL,
          guild_id: GUILD,
          content: `<@${BOT}> ${text}`,
          author: { id: OPERATOR, username: "paul" },
          timestamp: new Date().toISOString(),
        } satisfies DiscordMessage,
        "operator",
      );
    },
  };
}

describe("wakeup: <text> - the room", () => {
  test("an asleep room wakes and runs the text as its first turn", async () => {
    const h = room();
    // No row exists until the first message, so "not awake" is the honest check.
    expect(h.state() ?? "asleep").toBe("asleep");

    await h.at("wakeup: what time is it");
    const said = h.transport.sent.join("\n");

    expect(h.state()).toBe("awake");
    expect(said).toContain("Awake.");
    expect(said).toContain("echo: what time is it");
  });

  test("an awake room just takes the turn, with no wake chatter", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("hello");
    const before = h.transport.sent.length;

    await h.at("wakeup: and another thing");
    const said = h.transport.since(before);

    expect(said).toContain("echo: and another thing");
    expect(said).not.toContain("Already awake");
    expect(said).not.toContain("Awake.");
  });

  test("a bare wakeup still behaves exactly as before", async () => {
    const h = room();
    await h.at("wakeup");
    expect(h.state()).toBe("awake");
    expect(h.transport.sent.join("\n")).not.toContain("echo:");
  });

  test("the first turn is recorded like any other operator turn", async () => {
    const h = room();
    await h.at("wakeup: __ECHOPROMPT__");
    // The runtime saw the text, not the command wrapper.
    const said = h.transport.sent.join("\n");
    expect(said).toContain("__ECHOPROMPT__");
    expect(said).not.toContain("wakeup:");
  });
});
