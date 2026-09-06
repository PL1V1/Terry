/**
 * Two agents in one channel.
 *
 * A peer is another bot, named in PEER_AGENTS, that this one will hold a
 * conversation with. The interesting behaviour is not that it is let in - that
 * is one allowlist check - but everything bounding what happens next: it may
 * talk but not command, it must be answered with a real mention or it never
 * hears the reply, and the exchange is budgeted so two agents cannot answer
 * each other indefinitely.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { isAuthorised } from "../src/index.ts";
import { loadConfig, type AuthorKind, type Config } from "../src/config.ts";
import type { MessageTransport, SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import { FAKE_BIN } from "./acceptance.test.ts";

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
const PEER = "222222222222222222";
const STRANGER_BOT = "333333333333333333";
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
  PERMISSION_MODE: "plan",
  PERMISSION_PROMPTS: "none",
  HISTORY_LIMIT: "0",
};

/** Records what was said and, crucially, whether mentions were permitted. */
class FakeTransport implements MessageTransport {
  readonly sent: Array<{ text: string; replyTo?: string; allowMentions?: boolean }> = [];

  async sendMessage(
    channelId: string,
    text: string,
    options: { replyTo?: string; allowMentions?: boolean } = {},
  ): Promise<SentMessage[]> {
    this.sent.push({ text, replyTo: options.replyTo, allowMentions: options.allowMentions });
    return [{ id: `sent-${this.sent.length}`, channel_id: channelId }];
  }

  async recentMessages(): Promise<unknown[]> {
    return [];
  }

  get last(): string {
    return this.sent.at(-1)?.text ?? "";
  }
}

let counter = 0;

function messageFrom(
  authorId: string,
  text: string,
  overrides: Partial<DiscordMessage> = {},
): DiscordMessage {
  counter += 1;
  return {
    id: `m${counter}`,
    channel_id: CHANNEL,
    guild_id: GUILD,
    content: `<@${BOT}> ${text}`,
    author: { id: authorId, username: "someone" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const asPeer = { author: { id: PEER, username: "mate", bot: true } };

// ----------------------------------------------------------------- the gate

describe("peer agents - admission", () => {
  const config = loadConfig({ ...BASE_ENV, PEER_AGENTS: PEER });

  test("a named peer bot is admitted as a peer", () => {
    const verdict = isAuthorised(messageFrom(PEER, "hello", asPeer), config);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.author).toBe("peer" satisfies AuthorKind);
  });

  test("a human operator is still admitted as an operator", () => {
    const verdict = isAuthorised(messageFrom(OPERATOR, "hello"), config);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.author).toBe("operator" satisfies AuthorKind);
  });

  test("an unnamed bot is refused, as before", () => {
    const verdict = isAuthorised(
      messageFrom(STRANGER_BOT, "hello", {
        author: { id: STRANGER_BOT, username: "x", bot: true },
      }),
      config,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/peer agent/);
  });

  test("with no peers configured every bot is refused, exactly as it was", () => {
    const closed = loadConfig(BASE_ENV);
    expect(closed.peerAgents.size).toBe(0);
    expect(isAuthorised(messageFrom(PEER, "hello", asPeer), closed).ok).toBe(false);
  });

  test("a webhook is refused even when it wears a peer's id", () => {
    // A webhook carries no identity worth allowlisting, and anyone able to
    // create one in the channel could otherwise speak as the peer.
    const verdict = isAuthorised(
      messageFrom(PEER, "hello", { ...asPeer, webhook_id: "1234567890" }),
      config,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/webhook/);
  });

  test("a peer outside the allowlisted channel is still refused", () => {
    const verdict = isAuthorised(
      messageFrom(PEER, "hello", { ...asPeer, channel_id: "888888888888888888" }),
      config,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/channel/);
  });
});

// ------------------------------------------------------------------ the room

interface Harness {
  transport: FakeTransport;
  fromPeer(text: string): Promise<void>;
  fromOperator(text: string): Promise<void>;
}

function harness(env: Record<string, string> = {}): Harness {
  const config: Config = loadConfig({ ...BASE_ENV, PEER_AGENTS: PEER, ...env });
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

  return {
    transport,
    async fromPeer(text: string): Promise<void> {
      await room.handleMessage(messageFrom(PEER, text, asPeer), "peer");
    },
    async fromOperator(text: string): Promise<void> {
      await room.handleMessage(messageFrom(OPERATOR, text), "operator");
    },
  };
}

describe("peer agents - conversation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.fromOperator("wakeup");
  });

  test("a peer's message is answered, and the answer mentions it back", async () => {
    const before = h.transport.sent.length;
    await h.fromPeer("what are you working on?");
    const replies = h.transport.sent.slice(before);
    expect(replies.length).toBeGreaterThan(0);

    // Without both of these the peer never learns it was answered: the mention
    // is what triggers it, and allowed_mentions is what lets the ping through.
    const answer = replies.at(-1)!;
    expect(answer.text).toContain(`<@${PEER}>`);
    expect(answer.allowMentions).toBe(true);
  });

  test("an operator's answer does not ping anybody", async () => {
    const before = h.transport.sent.length;
    await h.fromOperator("what are you working on?");
    for (const sent of h.transport.sent.slice(before)) {
      expect(sent.allowMentions).toBeFalsy();
      expect(sent.text).not.toContain(`<@${PEER}>`);
    }
  });

  test("a peer cannot work the controls", async () => {
    const before = h.transport.sent.length;
    await h.fromPeer("sleep");
    // Not answered at all: a refusal is one more message it could reply to.
    expect(h.transport.sent.slice(before)).toHaveLength(0);
    // And the room is exactly where the operator left it.
    await h.fromOperator("status");
    expect(h.transport.last).toMatch(/awake/);
  });

  test("a peer cannot wake a sleeping room", async () => {
    await h.fromOperator("sleep");
    const before = h.transport.sent.length;
    await h.fromPeer("oi, wake up");
    expect(h.transport.sent.slice(before)).toHaveLength(0);
  });
});

describe("peer agents - the loop budget", () => {
  test("the exchange stops after the configured number of peer turns", async () => {
    const h = harness({ PEER_TURN_LIMIT: "3" });
    await h.fromOperator("wakeup");

    for (let i = 0; i < 3; i += 1) await h.fromPeer(`turn ${i}`);
    const before = h.transport.sent.length;

    await h.fromPeer("one turn too many");
    const after = h.transport.sent.slice(before);

    expect(after).toHaveLength(1);
    expect(after[0]!.text).toMatch(/stopped there/);
    // The message that stops a loop must not itself continue one.
    expect(after[0]!.text).not.toContain(`<@${PEER}>`);
    expect(after[0]!.allowMentions).toBeFalsy();
  });

  test("it says so once, not on every further attempt", async () => {
    const h = harness({ PEER_TURN_LIMIT: "1" });
    await h.fromOperator("wakeup");
    await h.fromPeer("first");

    await h.fromPeer("second");
    const afterNotice = h.transport.sent.length;
    await h.fromPeer("third");
    await h.fromPeer("fourth");

    expect(h.transport.sent.slice(afterNotice)).toHaveLength(0);
  });

  test("an operator speaking refills the budget", async () => {
    const h = harness({ PEER_TURN_LIMIT: "1" });
    await h.fromOperator("wakeup");
    await h.fromPeer("first");
    await h.fromPeer("blocked");

    await h.fromOperator("carry on you two");

    const before = h.transport.sent.length;
    await h.fromPeer("back in business");
    const replies = h.transport.sent.slice(before);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.at(-1)!.text).toContain(`<@${PEER}>`);
  });
});
