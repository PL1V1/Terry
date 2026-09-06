/**
 * Ambient listening.
 *
 * Being addressed opens an attention window; inside it, un-mentioned messages
 * are handed to the runtime to judge, and a message it judges is not for us is
 * answered with silence. Outside the window nothing reaches the runtime at all,
 * which is what keeps idle chatter free.
 *
 * The expensive mistakes are both failures of silence: answering a message that
 * was never meant for us, and posting a decline sentinel into the channel as if
 * it were an answer. Most of what follows is about those two.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { ambientPreamble, isDecline, NOT_FOR_ME } from "../src/controller/attention.ts";
import type { MessageTransport, SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import { FAKE_BIN } from "./acceptance.test.ts";

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
const PEER = "222222222222222222";
const GUILD = "444444444444444444";
const CHANNEL = "555555555555555555";
const BOT_ROLE = "999999999999999999";

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

const BASE_ENV = {
  CLAUDE_BIN: FAKE_BIN,
  DISCORD_TOKEN: "a-token-value-long-enough",
  DISCORD_APPLICATION_ID: BOT,
  ALLOWED_CHANNELS: CHANNEL,
  OPERATORS: OPERATOR,
  ALLOWED_GUILDS: GUILD,
  PEER_AGENTS: PEER,
  PERMISSION_MODE: "plan",
  PERMISSION_PROMPTS: "none",
  HISTORY_LIMIT: "0",
};

// -------------------------------------------------------------- the wrapper

describe("ambient listening - the check", () => {
  test("the preamble carries the message and the way out", () => {
    const wrapped = ambientPreamble("is that build done?");
    expect(wrapped).toContain("is that build done?");
    expect(wrapped).toContain(NOT_FOR_ME);
  });

  test("a bare sentinel is a decline", () => {
    expect(isDecline(NOT_FOR_ME)).toBe(true);
  });

  test("a decline is still recognised when the model dresses it up", () => {
    // Any of these posted to the channel as an answer would be gibberish, so
    // the recogniser is deliberately forgiving.
    expect(isDecline(`  ${NOT_FOR_ME}  `)).toBe(true);
    expect(isDecline(`\`${NOT_FOR_ME}\``)).toBe(true);
    expect(isDecline("```\n" + NOT_FOR_ME + "\n```")).toBe(true);
    expect(isDecline(`**${NOT_FOR_ME}**`)).toBe(true);
    expect(isDecline(`${NOT_FOR_ME}.`)).toBe(true);
  });

  test("an ordinary answer is never a decline", () => {
    expect(isDecline("Yeah, build's done.")).toBe(false);
    expect(isDecline("")).toBe(false);
    expect(isDecline(`I would reply ${NOT_FOR_ME} if it were not for me.`)).toBe(false);
  });
});

// ----------------------------------------------------------------- the room

class FakeTransport implements MessageTransport {
  readonly sent: string[] = [];

  async sendMessage(channelId: string, text: string): Promise<SentMessage[]> {
    this.sent.push(text);
    return [{ id: `sent-${this.sent.length}`, channel_id: channelId }];
  }

  async recentMessages(): Promise<unknown[]> {
    return [];
  }

  since(marker: number): string {
    return this.sent.slice(marker).join("\n---\n");
  }
}

let counter = 0;

interface Harness {
  transport: FakeTransport;
  /** An operator message addressed to the bot. */
  at(text: string): Promise<void>;
  /** An operator message that does not address anybody. */
  overheard(text: string): Promise<void>;
  /** A peer message that does not address anybody. */
  peerOverheard(text: string): Promise<void>;
}

function harness(env: Record<string, string> = {}): Harness {
  const config: Config = loadConfig({ ...BASE_ENV, ...env });
  const db = new Database(":memory:");
  migrateUp(db);
  const transport = new FakeTransport();
  const room = new RoomController(
    {
      config,
      repo: new Repo(db),
      rest: transport,
      caps: parseCapabilities(HELP, "2.1.263"),
      botId: BOT,
      botName: "Terry",
      selfMentionIds: () => new Set([BOT, BOT_ROLE]),
      onActivity: () => {},
    },
    GUILD,
    CHANNEL,
  );

  const send = async (content: string, authorId: string, bot: boolean): Promise<void> => {
    counter += 1;
    await room.handleMessage(
      {
        id: `a${counter}`,
        channel_id: CHANNEL,
        guild_id: GUILD,
        content,
        author: { id: authorId, username: "someone", ...(bot ? { bot: true } : {}) },
        timestamp: new Date().toISOString(),
      } satisfies DiscordMessage,
      bot ? "peer" : "operator",
    );
  };

  return {
    transport,
    at: (text) => send(`<@${BOT}> ${text}`, OPERATOR, false),
    overheard: (text) => send(text, OPERATOR, false),
    peerOverheard: (text) => send(text, PEER, true),
  };
}

describe("ambient listening - the window", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.at("wakeup");
  });

  test("nothing is overheard before anyone has spoken to him", async () => {
    // A fresh room that was only ever sent `wakeup` HAS been addressed, so this
    // uses a room that has not been.
    const fresh = harness();
    const before = fresh.transport.sent.length;
    await fresh.overheard("what do you reckon then");
    expect(fresh.transport.sent.slice(before)).toHaveLength(0);
  });

  test("an overheard message inside the window is answered", async () => {
    await h.at("hello");
    const before = h.transport.sent.length;
    await h.overheard("and what about the other thing?");
    expect(h.transport.since(before)).toContain("echo:");
  });

  test("a message he judges is not for him is answered with silence", async () => {
    await h.at("hello");
    const before = h.transport.sent.length;
    await h.overheard("__DECLINE__ eef did you see the game");
    // Not a word. In particular, not the sentinel.
    expect(h.transport.sent.slice(before)).toHaveLength(0);
  });

  test("the sentinel never reaches the channel", async () => {
    await h.at("hello");
    await h.overheard("__DECLINE__ something else entirely");
    expect(h.transport.sent.join("\n")).not.toContain(NOT_FOR_ME);
  });

  test("answering re-opens the window, so a conversation keeps running", async () => {
    const h2 = harness({ ATTENTION_WINDOW_SECONDS: "1" });
    await h2.at("wakeup");
    await h2.at("hello");

    // Each exchange pushes the window out, so the third message still lands
    // despite more than a second having passed since the mention.
    for (const text of ["one", "two", "three"]) {
      await Bun.sleep(400);
      const before = h2.transport.sent.length;
      await h2.overheard(text);
      expect(h2.transport.since(before)).toContain("echo:");
    }
  });

  test("the window closes after a quiet spell", async () => {
    const h2 = harness({ ATTENTION_WINDOW_SECONDS: "1" });
    await h2.at("wakeup");
    await h2.at("hello");

    await Bun.sleep(1200);
    const before = h2.transport.sent.length;
    await h2.overheard("still there?");
    expect(h2.transport.sent.slice(before)).toHaveLength(0);
  });

  test("a declined message does not hold the window open", async () => {
    const h2 = harness({ ATTENTION_WINDOW_SECONDS: "1" });
    await h2.at("wakeup");
    await h2.at("hello");

    await Bun.sleep(700);
    await h2.overheard("__DECLINE__ not for you");
    await Bun.sleep(700);

    // Over a second has now passed with nobody actually talking to him.
    const before = h2.transport.sent.length;
    await h2.overheard("what about now");
    expect(h2.transport.sent.slice(before)).toHaveLength(0);
  });

  test("a mention always works, window or no window", async () => {
    const h2 = harness({ ATTENTION_WINDOW_SECONDS: "1" });
    await h2.at("wakeup");
    await Bun.sleep(1200);

    const before = h2.transport.sent.length;
    await h2.at("oi");
    expect(h2.transport.since(before)).toContain("echo:");
  });
});

describe("ambient listening - what is never overheard", () => {
  test("a peer is never ambient, even inside an open window", async () => {
    const h = harness();
    await h.at("wakeup");
    await h.at("hello");

    const before = h.transport.sent.length;
    await h.peerOverheard("just chatting to my mate here");
    expect(h.transport.sent.slice(before)).toHaveLength(0);
  });

  test("a sleeping room overhears nothing", async () => {
    const h = harness();
    await h.at("wakeup");
    await h.at("hello");
    await h.at("sleep");

    const before = h.transport.sent.length;
    await h.overheard("you still about?");
    expect(h.transport.sent.slice(before)).toHaveLength(0);
  });

  test("a zero window disables ambient listening entirely", async () => {
    const h = harness({ ATTENTION_WINDOW_SECONDS: "0" });
    await h.at("wakeup");
    await h.at("hello");

    const before = h.transport.sent.length;
    await h.overheard("anything?");
    expect(h.transport.sent.slice(before)).toHaveLength(0);
  });

  test("status says whether he is listening", async () => {
    const h = harness({ ATTENTION_WINDOW_SECONDS: "0" });
    await h.at("wakeup");
    const before = h.transport.sent.length;
    await h.at("status");
    expect(h.transport.since(before)).toContain("Listening");
  });
});
