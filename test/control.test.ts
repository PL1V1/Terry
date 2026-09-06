/**
 * In-band control of the runtime.
 *
 * The stream-json channel accepts control requests - interrupt, set_model,
 * set_permission_mode - so three things that used to kill and restart the
 * process are now a message to the one already running. Effort is the
 * exception: the installed runtime reports set_effort unsupported, so an effort
 * change still restarts, and these tests hold that line too.
 *
 * The kill is kept as the fallback for every one of them. A runtime that
 * ignores an interrupt is terminated after the grace period; a switch the
 * runtime refuses falls through to a restart. Worst case is what it was.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import type { MessageTransport, SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import { FAKE_BIN } from "./acceptance.test.ts";

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
const PEER = "222222222222222222";
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

class Recorder implements MessageTransport {
  readonly sent: string[] = [];
  async sendMessage(channelId: string, text: string): Promise<SentMessage[]> {
    this.sent.push(text);
    return [{ id: `s${this.sent.length}`, channel_id: channelId }];
  }
  async recentMessages(): Promise<unknown[]> {
    return [];
  }
  get last(): string {
    return this.sent.at(-1) ?? "";
  }
}

let counter = 0;

function room(env: Record<string, string> = {}) {
  const config = loadConfig({
    CLAUDE_BIN: FAKE_BIN,
    DISCORD_TOKEN: "a-token-value-long-enough",
    DISCORD_APPLICATION_ID: BOT,
    ALLOWED_CHANNELS: CHANNEL,
    OPERATORS: OPERATOR,
    ALLOWED_GUILDS: GUILD,
    PEER_AGENTS: PEER,
    HISTORY_LIMIT: "0",
    STREAMING: "off",
    INTERRUPT_GRACE_MS: "300",
    ...env,
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
      selfMentionIds: () => new Set([BOT]),
      onActivity: () => {},
    },
    GUILD,
    CHANNEL,
  );
  const send = async (text: string, who: "operator" | "peer"): Promise<void> => {
    counter += 1;
    await controller.handleMessage(
      {
        id: String(730000000000000000n + BigInt(counter)),
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: `<@${BOT}> ${text}`,
        author: { id: who === "peer" ? PEER : OPERATOR, username: "x", ...(who === "peer" ? { bot: true } : {}) },
        timestamp: new Date().toISOString(),
      } satisfies DiscordMessage,
      who,
    );
  };
  const pid = (): string | undefined => /pid=([0-9]+)/.exec(transport.last)?.[1];
  return {
    transport,
    pid,
    at: (text: string) => send(text, "operator"),
    fromPeer: (text: string) => send(text, "peer"),
    shutdown: () => controller.shutdown(),
  };
}

describe("in-band control - interrupt", () => {
  test("stop interrupts the turn and keeps the process warm", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("first");
    const before = h.pid();

    const slow = h.at("__SLOW__");
    await Bun.sleep(150);
    await h.at("stop");
    await slow;
    expect(h.transport.sent.join("\n")).toContain("Task interrupted");

    await h.at("after");
    // Same process: the interrupt was in-band, not a kill.
    expect(h.pid()).toBe(before!);
    await h.shutdown();
  });

  test("a runtime that ignores the interrupt is terminated after the grace", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("first");
    const before = h.pid();

    const stubborn = h.at("__IGNORE_INTERRUPT__ __SLOW__");
    await Bun.sleep(150);
    await h.at("stop");
    await stubborn;

    await h.at("after");
    // A new process: the fallback did what the interrupt could not.
    expect(h.pid()).not.toBe(before!);
    expect(h.transport.last).toContain("resumed=true");
    await h.shutdown();
  });

  test("partial output before an in-band interrupt is still discarded", async () => {
    const h = room();
    await h.at("wakeup");
    const partial = h.at("__PARTIAL__");
    await Bun.sleep(150);
    await h.at("stop");
    await partial;
    expect(h.transport.sent.join("\n")).not.toContain("partial output before interrupt");
    await h.shutdown();
  });
});

describe("in-band control - settings", () => {
  test("a model change is a switch, not a restart", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("first");
    const before = h.pid();

    await h.at("model opus");
    await h.at("second");
    expect(h.transport.last).toContain("model=opus");
    expect(h.pid()).toBe(before!);
    await h.shutdown();
  });

  test("a model the runtime refuses falls back to a restart", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("first");
    const before = h.pid();

    await h.at("model bad-model");
    await h.at("second");
    // The stub refuses bad-model in-band but launches with it; the point is
    // that refusal produced a restart rather than a silent no-op.
    expect(h.pid()).not.toBe(before!);
    expect(h.transport.last).toContain("resumed=true");
    await h.shutdown();
  });

  test("an effort change still restarts, because the protocol cannot switch it", async () => {
    const h = room();
    await h.at("wakeup");
    await h.at("first");
    const before = h.pid();

    await h.at("effort high");
    await h.at("second");
    expect(h.transport.last).toContain("effort=high");
    expect(h.pid()).not.toBe(before!);
    await h.shutdown();
  });

  test("switching between an operator and a peer no longer restarts", async () => {
    const h = room({ PERMISSION_MODE: "acceptEdits" });
    await h.at("wakeup");
    await h.at("first");
    const before = h.pid();
    expect(h.transport.last).toContain("mode=acceptEdits");

    await h.fromPeer("hello from roy");
    expect(h.transport.last).toContain("mode=plan");
    expect(h.pid()).toBe(before!);

    await h.at("back to me");
    expect(h.transport.last).toContain("mode=acceptEdits");
    expect(h.pid()).toBe(before!);
    await h.shutdown();
  });
});
