/**
 * Version-pinned instructions.
 *
 * Instructions resolve live on every turn, which is right for editing and wrong
 * for a conversation already running under them: an edit rewrote the rules of a
 * live thread with nothing said. Pinning freezes what a conversation was minted
 * with, so a later edit becomes drift - visible, and adopted only on request.
 *
 * The decision lives in planPacket and is tested here without a database. The
 * room tests below then prove the plumbing: that pins get minted, that the
 * PINNED body is the one that reaches the runtime, and that accepting adopts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateUp } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";
import { RoomController } from "../src/controller/room.ts";
import { parseCapabilities } from "../src/runtime/capabilities.ts";
import { loadConfig, type Config } from "../src/config.ts";
import {
  driftNotice,
  hashBody,
  planPacket,
  renderPacket,
  type Instruction,
} from "../src/controller/pins.ts";
import type { MessageTransport, SentMessage } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import { FAKE_BIN } from "./acceptance.test.ts";

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
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

function ins(key: string, body: string, scope = "global"): Instruction {
  return { key, scope, body, sha256: hashBody(body) };
}

// ------------------------------------------------------------- the planner

describe("instruction pins - planning", () => {
  const never = () => false;
  const always = () => true;

  test("an unchanged component loads, and is not drift", () => {
    const a = ins("rules", "be brief");
    const plan = planPacket({
      keys: ["rules"],
      live: new Map([["rules", a]]),
      pins: new Map([["rules", a]]),
      isRequired: never,
      policy: "hold",
    });
    expect(plan.drifted).toEqual([]);
    expect(plan.use.map((i) => i.body)).toEqual(["be brief"]);
  });

  test("hold keeps the pinned body when the registry has moved", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map([["rules", ins("rules", "NEW")]]),
      pins: new Map([["rules", ins("rules", "OLD")]]),
      isRequired: never,
      policy: "hold",
    });
    expect(plan.drifted).toEqual(["rules"]);
    expect(plan.use.map((i) => i.body)).toEqual(["OLD"]);
  });

  test("live adopts the new body, and still reports the drift", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map([["rules", ins("rules", "NEW")]]),
      pins: new Map([["rules", ins("rules", "OLD")]]),
      isRequired: never,
      policy: "live",
    });
    expect(plan.drifted).toEqual(["rules"]);
    expect(plan.use.map((i) => i.body)).toEqual(["NEW"]);
  });

  test("off ignores pins entirely and resolves live", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map([["rules", ins("rules", "NEW")]]),
      pins: new Map([["rules", ins("rules", "OLD")]]),
      isRequired: never,
      policy: "off",
    });
    expect(plan.drifted).toEqual([]);
    expect(plan.use.map((i) => i.body)).toEqual(["NEW"]);
  });

  test("a key added after minting is loaded live, not called drift", () => {
    // There is no earlier version for it to have drifted from.
    const plan = planPacket({
      keys: ["rules", "voice"],
      live: new Map([
        ["rules", ins("rules", "same")],
        ["voice", ins("voice", "new key")],
      ]),
      pins: new Map([["rules", ins("rules", "same")]]),
      isRequired: never,
      policy: "hold",
    });
    expect(plan.drifted).toEqual([]);
    expect(plan.use.map((i) => i.key)).toEqual(["rules", "voice"]);
  });

  test("hold keeps a pinned body that has been deleted from the registry", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map(),
      pins: new Map([["rules", ins("rules", "OLD")]]),
      isRequired: always,
      policy: "hold",
    });
    expect(plan.vanished).toEqual(["rules"]);
    expect(plan.missing).toEqual([]);
    expect(plan.use.map((i) => i.body)).toEqual(["OLD"]);
  });

  test("live reports a required key deleted from the registry as missing", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map(),
      pins: new Map([["rules", ins("rules", "OLD")]]),
      isRequired: always,
      policy: "live",
    });
    expect(plan.vanished).toEqual(["rules"]);
    expect(plan.missing).toEqual(["rules"]);
    expect(plan.use).toEqual([]);
  });

  test("a required key with neither a live row nor a pin is missing", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map(),
      pins: new Map(),
      isRequired: always,
      policy: "hold",
    });
    expect(plan.missing).toEqual(["rules"]);
  });

  test("an optional key with nothing behind it is skipped silently", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map(),
      pins: new Map(),
      isRequired: never,
      policy: "hold",
    });
    expect(plan.missing).toEqual([]);
    expect(plan.use).toEqual([]);
  });

  test("the room's declared order is preserved", () => {
    const keys = ["c", "a", "b"];
    const live = new Map(keys.map((k) => [k, ins(k, k)]));
    const plan = planPacket({ keys, live, pins: new Map(), isRequired: never, policy: "hold" });
    expect(plan.use.map((i) => i.key)).toEqual(["c", "a", "b"]);
  });

  test("the packet is empty when there is nothing to load", () => {
    expect(renderPacket([])).toBe("");
  });

  test("a notice names the keys and how to adopt them", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map([["rules", ins("rules", "NEW")]]),
      pins: new Map([["rules", ins("rules", "OLD")]]),
      isRequired: never,
      policy: "hold",
    });
    const notice = driftNotice(plan, "hold", "@Terry")!;
    expect(notice).toContain("rules");
    expect(notice).toContain("accept instructions");
  });

  test("a live-policy notice does not tell you to accept anything", () => {
    const plan = planPacket({
      keys: ["rules"],
      live: new Map([["rules", ins("rules", "NEW")]]),
      pins: new Map([["rules", ins("rules", "OLD")]]),
      isRequired: never,
      policy: "live",
    });
    expect(driftNotice(plan, "live", "@Terry")).not.toContain("accept instructions");
  });

  test("no drift produces no notice at all", () => {
    const a = ins("rules", "same");
    const plan = planPacket({
      keys: ["rules"],
      live: new Map([["rules", a]]),
      pins: new Map([["rules", a]]),
      isRequired: never,
      policy: "hold",
    });
    expect(driftNotice(plan, "hold", "@Terry")).toBeNull();
    expect(plan.signature).toBe("");
  });

  test("editing the same key twice is a new signature, not the old one", () => {
    // A signature built from key names alone would call these identical, and the
    // second edit would never be reported.
    const pins = new Map([["rules", ins("rules", "OLD")]]);
    const first = planPacket({
      keys: ["rules"],
      live: new Map([["rules", ins("rules", "ONCE")]]),
      pins,
      isRequired: never,
      policy: "hold",
    });
    const second = planPacket({
      keys: ["rules"],
      live: new Map([["rules", ins("rules", "TWICE")]]),
      pins,
      isRequired: never,
      policy: "hold",
    });
    expect(first.drifted).toEqual(second.drifted);
    expect(first.signature).not.toBe(second.signature);
  });

  test("the signature does not depend on the order keys drifted in", () => {
    const live = new Map([["a", ins("a", "A2")], ["b", ins("b", "B2")]]);
    const pins = new Map([["a", ins("a", "A1")], ["b", ins("b", "B1")]]);
    const one = planPacket({ keys: ["a", "b"], live, pins, isRequired: never, policy: "hold" });
    const two = planPacket({ keys: ["b", "a"], live, pins, isRequired: never, policy: "hold" });
    expect(one.signature).toBe(two.signature);
  });

  test("hashing is over content, so identical bodies pin identically", () => {
    expect(hashBody("x")).toBe(hashBody("x"));
    expect(hashBody("x")).not.toBe(hashBody("y"));
  });
});

// ----------------------------------------------------------------- the room

interface Harness {
  repo: Repo;
  transport: FakeTransport;
  say(text: string): Promise<void>;
  pins(): Instruction[];
  sessionId(): string | null;
}

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

function harness(env: Record<string, string> = {}): Harness {
  const config: Config = loadConfig({ ...BASE_ENV, ...env });
  const db = new Database(":memory:");
  migrateUp(db);
  const repo = new Repo(db);
  const transport = new FakeTransport();
  const room = new RoomController(
    {
      config,
      repo,
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
    repo,
    transport,
    async say(text: string): Promise<void> {
      counter += 1;
      const message: DiscordMessage = {
        id: `p${counter}`,
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: `<@${BOT}> ${text}`,
        author: { id: OPERATOR, username: "paul" },
        timestamp: new Date().toISOString(),
      };
      await room.handleMessage(message, "operator");
    },
    pins(): Instruction[] {
      const sid = repo.getRoom(GUILD, CHANNEL)?.session_id;
      return sid ? repo.instructionPins(GUILD, CHANNEL, sid) : [];
    },
    sessionId(): string | null {
      return repo.getRoom(GUILD, CHANNEL)?.session_id ?? null;
    },
  };
}

/** Gives the room one instruction key resolving to `body`. */
function seed(h: Harness, body: string, key = "rules"): void {
  h.repo.upsertInstruction({ key, scope: "global", scope_id: "", body });
  h.repo.setRoomInstructions(GUILD, CHANNEL, [key]);
}

describe("instruction pins - minting", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test("a conversation's first turn mints what it was told", async () => {
    seed(h, "be brief");
    expect(h.pins()).toHaveLength(0);

    await h.say("wakeup");
    await h.say("hello");

    const pins = h.pins();
    expect(pins).toHaveLength(1);
    expect(pins[0]!.key).toBe("rules");
    expect(pins[0]!.sha256).toBe(hashBody("be brief"));
  });

  test("policy off mints nothing at all", async () => {
    h = harness({ INSTRUCTION_DRIFT_POLICY: "off" });
    seed(h, "be brief");
    await h.say("wakeup");
    await h.say("hello");
    expect(h.pins()).toHaveLength(0);
  });

  test("a room with no instructions pins nothing and still works", async () => {
    await h.say("wakeup");
    const before = h.transport.sent.length;
    await h.say("hello");
    expect(h.pins()).toHaveLength(0);
    expect(h.transport.since(before)).toContain("echo:");
  });
});

describe("instruction pins - drift", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    seed(h, "ORIGINAL-BODY");
    await h.say("wakeup");
    await h.say("mint it");
  });

  test("the pinned body is what reaches the runtime, not the edited one", async () => {
    seed(h, "EDITED-BODY");

    const before = h.transport.sent.length;
    await h.say("__ECHOPROMPT__");
    const said = h.transport.since(before);

    // The whole point of the feature, asserted on the actual prompt.
    expect(said).toContain("ORIGINAL-BODY");
    expect(said).not.toContain("EDITED-BODY");
  });

  test("under policy live the edited body is what reaches the runtime", async () => {
    h = harness({ INSTRUCTION_DRIFT_POLICY: "live" });
    seed(h, "ORIGINAL-BODY");
    await h.say("wakeup");
    await h.say("mint it");
    seed(h, "EDITED-BODY");

    const before = h.transport.sent.length;
    await h.say("__ECHOPROMPT__");
    const said = h.transport.since(before);

    expect(said).toContain("EDITED-BODY");
    expect(said).not.toContain("ORIGINAL-BODY");
  });

  test("the drift is reported, naming the key", async () => {
    seed(h, "EDITED-BODY");
    const before = h.transport.sent.length;
    await h.say("hello");
    const said = h.transport.since(before);
    expect(said).toContain("rules");
    expect(said).toContain("accept instructions");
  });

  test("the same drift is reported once, not on every turn", async () => {
    seed(h, "EDITED-BODY");
    await h.say("first");

    const before = h.transport.sent.length;
    await h.say("second");
    await h.say("third");
    expect(h.transport.since(before)).not.toContain("accept instructions");
  });

  test("a further edit is a new drift state, and is reported again", async () => {
    seed(h, "EDITED-ONCE");
    await h.say("first");

    seed(h, "EDITED-TWICE");
    const before = h.transport.sent.length;
    await h.say("second");
    expect(h.transport.since(before)).toContain("accept instructions");
  });

  test("no edit means nothing is said about instructions at all", async () => {
    const before = h.transport.sent.length;
    await h.say("hello");
    expect(h.transport.since(before)).not.toContain("accept instructions");
  });
});

describe("instruction pins - accepting", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    seed(h, "ORIGINAL-BODY");
    await h.say("wakeup");
    await h.say("mint it");
    seed(h, "EDITED-BODY");
  });

  test("accepting re-pins to the current registry", async () => {
    await h.say("accept instructions");
    expect(h.pins()[0]!.sha256).toBe(hashBody("EDITED-BODY"));
  });

  test("after accepting, the new body is what reaches the runtime", async () => {
    await h.say("accept instructions");

    const before = h.transport.sent.length;
    await h.say("__ECHOPROMPT__");
    const said = h.transport.since(before);

    expect(said).toContain("EDITED-BODY");
    expect(said).not.toContain("ORIGINAL-BODY");
  });

  test("after accepting there is no drift left to report", async () => {
    await h.say("accept instructions");
    const before = h.transport.sent.length;
    await h.say("hello");
    expect(h.transport.since(before)).not.toContain("accept instructions");
  });

  test("the status command shows the drift before it is accepted", async () => {
    const before = h.transport.sent.length;
    await h.say("instructions");
    expect(h.transport.since(before)).toContain("drifted");
  });

  test("the status command shows it clean afterwards", async () => {
    await h.say("accept instructions");
    const before = h.transport.sent.length;
    await h.say("instructions");
    const said = h.transport.since(before);
    expect(said).toContain("rules");
    expect(said).not.toContain("drifted");
  });
});
