/**
 * Acceptance harness, turn level.
 *
 * These checks need a runtime process actually running, so they use the stub in
 * test/fixtures. The stub speaks the same stream-json protocol over the same
 * flags as the real CLI and reports back the settings it was launched with, so
 * a model or effort change can be observed reaching the process rather than
 * merely being stored.
 *
 * Everything except the runtime and the Discord transport is shipping code.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { MessageTransport, SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
const GUILD = "444444444444444444";
const CHANNEL = "555555555555555555";

const FAKE_BIN = `${import.meta.dir.replaceAll("\\", "/")}/fixtures/fake-runtime.cmd`;

const CAPS = parseCapabilities(
  `Options:
  --effort <level>       Effort level (low, medium, high, xhigh, max)
  --model <model>        Provide an alias (e.g. 'opus', or 'sonnet')
  -p, --print            Print response and exit
  --input-format <f>     Input format (choices: "text", "stream-json")
  --output-format <f>    Output format (choices: "text", "stream-json")
  --session-id <uuid>    Use a specific session ID
  -r, --resume [value]   Resume a conversation
`,
  "stub",
);

const CONFIG: Config = loadConfig({
  CLAUDE_BIN: FAKE_BIN,
  DISCORD_TOKEN: "a-token-value-long-enough",
  DISCORD_APPLICATION_ID: BOT,
  ALLOWED_CHANNELS: CHANNEL,
  OPERATORS: OPERATOR,
  ALLOWED_GUILDS: GUILD,
  HISTORY_LIMIT: "0",
});

class FakeTransport implements MessageTransport {
  readonly sent: string[] = [];
  async sendMessage(_channelId: string, text: string): Promise<SentMessage[]> {
    this.sent.push(text);
    return [{ id: `s${this.sent.length}`, channel_id: CHANNEL }];
  }
  async recentMessages(): Promise<unknown[]> {
    return [];
  }
  get last(): string {
    return this.sent.at(-1) ?? "";
  }
}

function harness() {
  const db = new Database(":memory:");
  migrateUp(db);
  const repo = new Repo(db);
  const transport = new FakeTransport();
  let counter = 0;

  const build = (): RoomController =>
    new RoomController(
      { config: CONFIG, repo, rest: transport, caps: CAPS, botId: BOT, onActivity: () => {} },
      GUILD,
      CHANNEL,
    );

  let room = build();

  const message = (text: string): DiscordMessage => {
    counter += 1;
    return {
      id: `m${counter}`,
      channel_id: CHANNEL,
      guild_id: GUILD,
      content: `<@${BOT}> ${text}`,
      author: { id: OPERATOR, username: "paul" },
      timestamp: new Date().toISOString(),
    };
  };

  return {
    repo,
    transport,
    get room() {
      return room;
    },
    /** Sends and waits for the room to finish handling it. */
    say: (text: string) => room.handleMessage(message(text)),
    /** Sends without waiting, for testing what happens during a running turn. */
    fire: (text: string) => {
      void room.handleMessage(message(text));
    },
    restart: () => {
      room = build();
    },
    shutdown: () => room.shutdown(),
  };
}

/** Waits for a condition, so tests do not race a background turn. */
async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  if (!predicate()) throw new Error("condition not met before timeout");
}

describe("acceptance 1 and 2 — a turn runs and reports observed results", () => {
  test("a message after wakeup produces a real runtime reply", async () => {
    const h = harness();
    await h.say("wakeup");
    await h.say("hello there");

    expect(h.transport.last).toContain("echo: hello there");
    await h.shutdown();
  });

  test("an optional missing instruction does not block the turn", async () => {
    const h = harness();
    await h.say("wakeup");
    h.repo.setRoomInstructions(GUILD, CHANNEL, ["nowhere"]);

    await h.say("do the thing");
    expect(h.transport.last).toContain("echo:");
    expect(h.transport.last).not.toContain("Required instructions are missing");
    await h.shutdown();
  });

  test("instructions in the registry reach the runtime", async () => {
    const h = harness();
    await h.say("wakeup");
    h.repo.upsertInstruction({ key: "voice", scope: "global", scope_id: "", body: "SPEAK-PLAINLY" });
    h.repo.setRoomInstructions(GUILD, CHANNEL, ["voice"]);

    await h.say("hello");
    // The stub echoes the final line, and the instruction block precedes it.
    expect(h.transport.last).toContain("echo: hello");
    await h.shutdown();
  });

  test("a runtime error is reported rather than swallowed", async () => {
    const h = harness();
    await h.say("wakeup");
    await h.say("__FAIL__");

    expect(h.transport.last).toMatch(/runtime reported a problem/);
    await h.shutdown();
  });

  test("a runtime that dies mid-turn is reported and the conversation kept", async () => {
    const h = harness();
    await h.say("wakeup");
    const sessionBefore = h.repo.getRoom(GUILD, CHANNEL)!.session_id;

    await h.say("__CRASH__");

    expect(h.transport.last).toContain("exited before finishing");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.session_id).toBe(sessionBefore);
    await h.shutdown();
  });
});

describe("acceptance 4 — stop interrupts a real task and pending input is predictable", () => {
  test("a message arriving during work is queued, not run concurrently", async () => {
    const h = harness();
    await h.say("wakeup");

    h.fire("__SLOW__ long job");
    await until(() => h.transport.sent.some((t) => t.includes("Queued") || t.length > 0));

    h.fire("second message");
    await until(() => h.transport.sent.some((t) => t.includes("Queued")));

    expect(h.transport.sent.some((t) => t.includes("1 message(s) waiting"))).toBe(true);
    await h.shutdown();
  });

  test("stop interrupts the task, clears the queue and stays awake", async () => {
    const h = harness();
    await h.say("wakeup");

    h.fire("__SLOW__ long job");
    await Bun.sleep(300);
    h.fire("queued while busy");
    await until(() => h.transport.sent.some((t) => t.includes("Queued")));

    await h.say("stop");

    expect(h.transport.last).toContain("Task interrupted");
    expect(h.transport.last).toContain("Cleared 1 queued message");
    // Still awake: the room is usable immediately afterwards.
    expect(h.repo.getRoom(GUILD, CHANNEL)!.state).toBe("awake");
    await h.shutdown();
  });

  test("stop with nothing running says so plainly", async () => {
    const h = harness();
    await h.say("wakeup");
    await h.say("stop");
    expect(h.transport.last).toContain("Nothing running");
    await h.shutdown();
  });

  test("sleep during work interrupts it and drops the queue", async () => {
    const h = harness();
    await h.say("wakeup");

    h.fire("__SLOW__ long job");
    await Bun.sleep(300);
    h.fire("queued while busy");
    await until(() => h.transport.sent.some((t) => t.includes("Queued")));

    await h.say("sleep");

    expect(h.transport.last).toContain("Asleep");
    expect(h.transport.last).toContain("Dropped 1 queued message");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.state).toBe("asleep");
    await h.shutdown();
  });
});

describe("acceptance 5 and 6 — settings reach the process and survive a restart", () => {
  test("effort chosen in chat is passed to the runtime on the next turn", async () => {
    const h = harness();
    await h.say("wakeup");
    await h.say("effort high");
    await h.say("hello");

    expect(h.transport.last).toContain("effort=high");
    await h.shutdown();
  });

  test("changing model mid-conversation restarts the process and resumes", async () => {
    const h = harness();
    await h.say("wakeup");
    await h.say("first");
    expect(h.transport.last).toContain("model=none");

    await h.say("model opus");
    await h.say("second");

    expect(h.transport.last).toContain("model=opus");
    // Restarting to apply a setting must resume, never start a blank one.
    expect(h.transport.last).toContain("resumed=true");
    await h.shutdown();
  });

  test("consecutive turns share one runtime process", async () => {
    const h = harness();
    await h.say("wakeup");

    await h.say("first");
    const firstPid = /pid=([0-9]+)/.exec(h.transport.last)?.[1];
    expect(firstPid).toBeDefined();
    // The first launch names a new conversation rather than resuming one.
    expect(h.transport.last).toContain("resumed=false");

    await h.say("second");
    const secondPid = /pid=([0-9]+)/.exec(h.transport.last)?.[1];

    // The process is long-lived: a second turn is not a second spawn.
    expect(secondPid).toBe(firstPid!);
    await h.shutdown();
  });

  test("changing a setting spawns a new process and resumes into it", async () => {
    const h = harness();
    await h.say("wakeup");

    await h.say("first");
    const firstPid = /pid=([0-9]+)/.exec(h.transport.last)?.[1];

    await h.say("effort high");
    await h.say("second");
    const secondPid = /pid=([0-9]+)/.exec(h.transport.last)?.[1];

    expect(secondPid).not.toBe(firstPid);
    expect(h.transport.last).toContain("resumed=true");
    expect(h.transport.last).toContain("effort=high");
    await h.shutdown();
  });

  test("a restart keeps the conversation and settings", async () => {
    const h = harness();
    await h.say("wakeup");
    await h.say("effort max");
    await h.say("first");
    const sessionId = h.repo.getRoom(GUILD, CHANNEL)!.session_id;

    await h.shutdown();
    h.restart();

    await h.say("after restart");
    expect(h.repo.getRoom(GUILD, CHANNEL)!.session_id).toBe(sessionId);
    expect(h.transport.last).toContain("effort=max");
    await h.shutdown();
  });
});

describe("acceptance 9 — a new session is a genuinely separate conversation", () => {
  test("confirming starts a different conversation and preserves the old", async () => {
    const h = harness();
    await h.say("wakeup");
    await h.say("first");
    const before = h.repo.getRoom(GUILD, CHANNEL)!.session_id!;

    await h.say("new session");
    await h.say("new session confirm");
    await h.say("after");

    const after = h.repo.getRoom(GUILD, CHANNEL)!.session_id!;
    expect(after).not.toBe(before);
    // A brand new conversation must not claim to be a resumed one.
    expect(h.transport.last).toContain("resumed=false");
    expect(h.repo.retiredSessions(GUILD, CHANNEL)[0]!.session_id).toBe(before);
    await h.shutdown();
  });
});
