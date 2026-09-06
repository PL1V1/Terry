/**
 * Acceptance harness.
 *
 * Drives the real RoomController against a real database with a stand-in for
 * Discord's socket, so the checks in docs/acceptance.md that are not actually
 * about Discord can be demonstrated without a bot token.
 *
 * Nothing here is mocked except the transport: the state machine, the command
 * layer, the registry and the persistence are the shipping code.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { MessageTransport, SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import type { ServiceState } from "../src/discord/presence.ts";

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
const GUILD = "444444444444444444";
const CHANNEL = "555555555555555555";
const OTHER_CHANNEL = "666666666666666666";
/** The managed role Discord creates for the bot. */
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

/** Stands in for Discord. Records everything the room tries to say. */
class FakeTransport implements MessageTransport {
  readonly sent: Array<{ channelId: string; text: string; replyTo?: string }> = [];
  history: DiscordMessage[] = [];

  async sendMessage(
    channelId: string,
    text: string,
    options: { replyTo?: string } = {},
  ): Promise<SentMessage[]> {
    this.sent.push({ channelId, text, ...(options.replyTo ? { replyTo: options.replyTo } : {}) });
    return [{ id: `sent-${this.sent.length}`, channel_id: channelId }];
  }

  async recentMessages(): Promise<unknown[]> {
    return this.history;
  }

  /** Everything said since the marker, joined. */
  since(marker: number): string {
    return this.sent.slice(marker).map((s) => s.text).join("\n---\n");
  }

  get last(): string {
    return this.sent.at(-1)?.text ?? "";
  }
}

/** The stub runtime, addressed with forward slashes so Bun can spawn it. */
export const FAKE_BIN = `${import.meta.dir.replaceAll("\\", "/")}/fixtures/fake-runtime.cmd`;

const CONFIG: Config = loadConfig({
  CLAUDE_BIN: FAKE_BIN,
  DISCORD_TOKEN: "a-token-value-long-enough",
  DISCORD_APPLICATION_ID: BOT,
  ALLOWED_CHANNELS: `${CHANNEL},${OTHER_CHANNEL}`,
  OPERATORS: OPERATOR,
  ALLOWED_GUILDS: GUILD,
  PERMISSION_MODE: "plan",
  PERMISSION_PROMPTS: "none",
  HISTORY_LIMIT: "0",
});

const CAPS = parseCapabilities(HELP, "2.1.263");

interface Harness {
  db: Database;
  repo: Repo;
  transport: FakeTransport;
  activity: Array<{ state: ServiceState; activity: string | null }>;
  room: RoomController;
  /** Sends a message from the operator, addressed to the bot. */
  say(text: string, channelId?: string): Promise<void>;
  /** Rebuilds the controller from the same database, as a restart would. */
  restart(channelId?: string): RoomController;
}

function harness(): Harness {
  const db = new Database(":memory:");
  migrateUp(db);
  const repo = new Repo(db);
  const transport = new FakeTransport();
  const activity: Array<{ state: ServiceState; activity: string | null }> = [];
  let counter = 0;

  const build = (channelId: string): RoomController =>
    new RoomController(
      {
        config: CONFIG,
        repo,
        rest: transport,
        caps: CAPS,
        botId: BOT,
        selfMentionIds: () => new Set([BOT, BOT_ROLE]),
        onActivity: (state, text) => activity.push({ state, activity: text }),
      },
      GUILD,
      channelId,
    );

  let room = build(CHANNEL);

  return {
    db,
    repo,
    transport,
    activity,
    get room() {
      return room;
    },
    async say(text: string, channelId = CHANNEL): Promise<void> {
      counter += 1;
      const target = channelId === CHANNEL ? room : build(channelId);
      const message: DiscordMessage = {
        id: `m${counter}`,
        channel_id: channelId,
        guild_id: GUILD,
        content: `<@${BOT}> ${text}`,
        author: { id: OPERATOR, username: "paul" },
        timestamp: new Date().toISOString(),
      };
      await target.handleMessage(message);
    },
    restart(channelId = CHANNEL): RoomController {
      room = build(channelId);
      return room;
    },
  } as Harness;
}

// ---------------------------------------------------------------------------

describe("acceptance 3 — sleep ignores chat, controls still work", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test("a fresh room starts asleep", () => {
    expect(h.repo.ensureRoom(GUILD, CHANNEL).state).toBe("asleep");
  });

  test("ordinary chat while asleep produces silence, not a refusal", async () => {
    await h.say("are you there? please do some work");
    expect(h.transport.sent).toHaveLength(0);
  });

  test("menu, status and ping still answer while asleep", async () => {
    await h.say("menu");
    expect(h.transport.last).toContain("wakeup");

    await h.say("status");
    expect(h.transport.last).toContain("asleep");

    await h.say("ping");
    expect(h.transport.last).toContain("2.1.263");
  });

  test("sleep after waking clears the queue and reports it", async () => {
    await h.say("wakeup");
    const mark = h.transport.sent.length;
    await h.say("sleep");
    expect(h.transport.since(mark)).toContain("Asleep");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.state).toBe("asleep");
  });

  test("chat is ignored again once asleep", async () => {
    await h.say("wakeup");
    await h.say("sleep");
    const mark = h.transport.sent.length;
    await h.say("do something");
    expect(h.transport.sent).toHaveLength(mark);
  });
});

describe("acceptance 5 — model and effort come from real capabilities", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.say("wakeup");
  });

  test("effort lists what the runtime documents", async () => {
    await h.say("effort");
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(h.transport.last).toContain(level);
    }
  });

  test("an invalid effort is rejected and shows the real list", async () => {
    await h.say("effort banana");
    expect(h.transport.last).toContain("not a supported effort level");
    expect(h.transport.last).toContain("xhigh");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.effort).toBeNull();
  });

  test("a valid effort is stored and said to apply next turn", async () => {
    await h.say("effort high");
    expect(h.transport.last).toContain("next turn");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.effort).toBe("high");
  });

  test("list models reports the runtime's own aliases", async () => {
    await h.say("list models");
    expect(h.transport.last).toContain("opus");
    expect(h.transport.last).toContain("not a complete catalogue");
  });

  test("an unrecognised model is stored but flagged honestly", async () => {
    await h.say("model something-invented");
    expect(h.transport.last).toContain("not one of the aliases");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.model).toBe("something-invented");
  });

  test("settings survive a restart", async () => {
    await h.say("effort high");
    await h.say("model opus");

    h.restart();
    await h.say("status");

    expect(h.transport.last).toContain("high");
    expect(h.transport.last).toContain("opus");
  });

  test("two channels keep separate settings", async () => {
    await h.say("effort high");
    await h.say("wakeup", OTHER_CHANNEL);
    await h.say("effort low", OTHER_CHANNEL);

    expect(h.repo.getRoom(GUILD, CHANNEL)!.effort).toBe("high");
    expect(h.repo.getRoom(GUILD, OTHER_CHANNEL)!.effort).toBe("low");
  });
});

describe("acceptance 7 — instructions are live and required keys are enforced", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.say("wakeup");
  });

  test("a missing required instruction refuses the turn and names the key", async () => {
    h.repo.upsertInstruction({ key: "house", scope: "global", scope_id: "", body: "x", required: true });
    h.repo.setRoomInstructions(GUILD, CHANNEL, ["house"]);
    // Remove the body but leave the room pointing at the key.
    h.db.query("DELETE FROM instructions WHERE key = 'house'").run();
    h.repo.upsertInstruction({ key: "house", scope: "guild", scope_id: "other", body: "y", required: true });

    const mark = h.transport.sent.length;
    await h.say("do the thing");

    const said = h.transport.since(mark);
    expect(said).toContain("Required instructions are missing");
    expect(said).toContain("house");
  });

  test("an optional missing instruction does not block the turn", async () => {
    h.repo.setRoomInstructions(GUILD, CHANNEL, ["nowhere"]);
    const mark = h.transport.sent.length;
    await h.say("do the thing");
    expect(h.transport.since(mark)).not.toContain("Required instructions are missing");
  });

  test("registry edits need no restart to take effect", async () => {
    h.repo.upsertInstruction({ key: "voice", scope: "global", scope_id: "", body: "first version" });
    h.repo.setRoomInstructions(GUILD, CHANNEL, ["voice"]);
    expect(h.repo.resolveInstruction("voice", GUILD, CHANNEL)!.body).toBe("first version");

    h.repo.upsertInstruction({ key: "voice", scope: "global", scope_id: "", body: "second version" });
    expect(h.repo.resolveInstruction("voice", GUILD, CHANNEL)!.body).toBe("second version");
  });
});

describe("acceptance 9 — new session confirms, and preserves the old one", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.say("wakeup");
  });

  test("the ask warns, names the conversation, and changes nothing", async () => {
    const before = h.repo.getRoom(GUILD, CHANNEL)!.session_id;
    await h.say("new session");

    expect(h.transport.last).toContain("replaces this room's conversation");
    expect(h.transport.last).toContain("not deleted");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.session_id).toBe(before);
  });

  test("confirming replaces the conversation and files the old one", async () => {
    const before = h.repo.getRoom(GUILD, CHANNEL)!.session_id!;
    await h.say("new session");
    await h.say("new session confirm");

    const after = h.repo.getRoom(GUILD, CHANNEL)!.session_id!;
    expect(after).not.toBe(before);

    const history = h.repo.retiredSessions(GUILD, CHANNEL);
    expect(history).toHaveLength(1);
    expect(history[0]!.session_id).toBe(before);
  });

  test("confirming without asking first is refused", async () => {
    const before = h.repo.getRoom(GUILD, CHANNEL)!.session_id;
    await h.say("new session confirm");
    expect(h.transport.last).toContain("Nothing to confirm");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.session_id).toBe(before);
  });

  test("another command cancels a pending confirmation", async () => {
    const before = h.repo.getRoom(GUILD, CHANNEL)!.session_id;
    await h.say("new session");
    await h.say("status");
    await h.say("new session confirm");

    expect(h.transport.last).toContain("Nothing to confirm");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.session_id).toBe(before);
  });
});

describe("acceptance 8 — presence follows room state", () => {
  test("waking and sleeping move the reported state", async () => {
    const h = harness();
    await h.say("wakeup");
    expect(h.activity.at(-1)!.state).toBe("awake");

    await h.say("sleep");
    expect(h.activity.at(-1)!.state).toBe("asleep");
  });

  test("custom activity text is reported and can be reset", async () => {
    const h = harness();
    await h.say("wakeup");

    await h.say("activity on the tools");
    expect(h.activity.at(-1)!.activity).toBe("on the tools");

    await h.say("activity auto");
    expect(h.activity.at(-1)!.activity).toBeNull();
  });
});
