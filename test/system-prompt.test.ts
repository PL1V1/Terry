/**
 * Pinned instructions as a system prompt.
 *
 * Inside every message, the house rules piled up in the conversation - the same
 * six hundred tokens on every turn, paid for on every turn and pushing real
 * history out of the window. A pinned set does not change for a conversation's
 * life, which is exactly the shape a system prompt wants: sent once at process
 * start, cached, never repeated.
 *
 * The stub echoes both channels labelled, so these tests assert not just that
 * an instruction reached the runtime but which way it went.
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
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keeps system-prompt files the room writes out of the live data directory. */
const SCRATCH_DB = join(tmpdir(), "terry-tests", "terry.sqlite");

const BOT = "111111111111111111";
const OPERATOR = "777777777777777777";
const GUILD = "444444444444444444";
const CHANNEL = "555555555555555555";

const HELP_WITH = `Options:
  --effort <level>       Effort level (low, medium, high, xhigh, max)
  --model <model>        Provide an alias (e.g. 'fable', 'opus', or 'sonnet')
  --permission-mode <m>  mode (choices: "acceptEdits", "plan")
  --permission-prompts <t>  target (choices: "host", "none")
  --append-system-prompt <prompt>  Append a system prompt to the default
  -p, --print            Print response and exit
  --input-format <f>     Input format (choices: "text", "stream-json")
  --output-format <f>    Output format (choices: "text", "stream-json")
  --session-id <uuid>    Use a specific session ID
  -r, --resume [value]   Resume a conversation
`;
const HELP_WITHOUT = HELP_WITH.replace(/^.*--append-system-prompt.*\n/m, "");

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

/** Splits the stub's echo into what came via the system prompt and what came in the message. */
function channels(echo: string): { system: string; message: string } {
  const m = /\[system\]\n([\s\S]*?)\n\[message\]\n([\s\S]*)$/.exec(echo);
  return { system: m?.[1] ?? "", message: m?.[2] ?? "" };
}

let counter = 0;

function room(env: Record<string, string> = {}, help = HELP_WITH) {
  const config = loadConfig({
    CLAUDE_BIN: FAKE_BIN,
    DISCORD_TOKEN: "a-token-value-long-enough",
    DISCORD_APPLICATION_ID: BOT,
  DATABASE_PATH: SCRATCH_DB,
    ALLOWED_CHANNELS: CHANNEL,
    OPERATORS: OPERATOR,
    ALLOWED_GUILDS: GUILD,
    HISTORY_LIMIT: "0",
    STREAMING: "off",
    ...env,
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
      caps: parseCapabilities(help, "2.1.263"),
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
    seed(body: string, key = "rules"): void {
      repo.upsertInstruction({ key, scope: "global", scope_id: "", body });
      repo.setRoomInstructions(GUILD, CHANNEL, [key]);
    },
    pid: (): string | undefined => /pid=([0-9]+)/.exec(transport.last)?.[1],
    async at(text: string): Promise<void> {
      counter += 1;
      await controller.handleMessage(
        {
          id: String(740000000000000000n + BigInt(counter)),
          channel_id: CHANNEL,
          guild_id: GUILD,
          content: `<@${BOT}> ${text}`,
          author: { id: OPERATOR, username: "paul" },
          timestamp: new Date().toISOString(),
        } satisfies DiscordMessage,
        "operator",
      );
    },
    shutdown: () => controller.shutdown(),
  };
}

describe("instructions in the system prompt", () => {
  test("pinned instructions travel in the system prompt, not the message", async () => {
    const h = room();
    h.seed("BE-BRIEF-MARKER");
    await h.at("wakeup");
    await h.at("__ECHOPROMPT__");

    const { system, message } = channels(h.transport.last);
    expect(system).toContain("BE-BRIEF-MARKER");
    expect(message).not.toContain("BE-BRIEF-MARKER");
    // The operator's own text still arrives in the message.
    expect(message).toContain("__ECHOPROMPT__");
    await h.shutdown();
  });

  test("the process is not restarted while the instructions stay pinned", async () => {
    const h = room();
    h.seed("STABLE");
    await h.at("wakeup");
    await h.at("first");
    const before = h.pid();
    await h.at("second");
    await h.at("third");
    expect(h.pid()).toBe(before!);
    await h.shutdown();
  });

  test("an edit in the registry does not reach a pinned conversation", async () => {
    const h = room();
    h.seed("ORIGINAL");
    await h.at("wakeup");
    await h.at("mint it");
    const before = h.pid();

    h.seed("EDITED");
    await h.at("__ECHOPROMPT__");
    const { system } = channels(h.transport.last);
    expect(system).toContain("ORIGINAL");
    expect(system).not.toContain("EDITED");
    // Held to the pin, so nothing changed and nothing restarted.
    await h.at("still here");
    expect(h.pid()).toBe(before!);
    await h.shutdown();
  });

  test("accepting the edit restarts the process with the new system prompt", async () => {
    const h = room();
    h.seed("ORIGINAL");
    await h.at("wakeup");
    await h.at("mint it");
    const before = h.pid();

    h.seed("EDITED");
    await h.at("accept instructions");
    await h.at("__ECHOPROMPT__");
    const { system } = channels(h.transport.last);
    expect(system).toContain("EDITED");
    expect(system).not.toContain("ORIGINAL");
    // A system prompt cannot change in-band, so this is the one setting that
    // always restarts - and it resumes the same conversation.
    await h.at("and now");
    expect(h.pid()).not.toBe(before!);
    expect(h.transport.last).toContain("resumed=true");
    await h.shutdown();
  });
});

describe("instructions stay in the message when they must", () => {
  test("with the drift policy off, they resolve live in the message", async () => {
    const h = room({ INSTRUCTION_DRIFT_POLICY: "off" });
    h.seed("LIVE-BODY");
    await h.at("wakeup");
    await h.at("__ECHOPROMPT__");
    const { system, message } = channels(h.transport.last);
    expect(message).toContain("LIVE-BODY");
    expect(system).toBe("");
    await h.shutdown();
  });

  test("when the operator turns it off", async () => {
    const h = room({ INSTRUCTIONS_IN_SYSTEM_PROMPT: "off" });
    h.seed("IN-MESSAGE");
    await h.at("wakeup");
    await h.at("__ECHOPROMPT__");
    const { system, message } = channels(h.transport.last);
    expect(message).toContain("IN-MESSAGE");
    expect(system).toBe("");
    await h.shutdown();
  });

  test("when the runtime does not advertise the flag", async () => {
    const h = room({}, HELP_WITHOUT);
    h.seed("OLD-RUNTIME");
    await h.at("wakeup");
    await h.at("__ECHOPROMPT__");
    const { system, message } = channels(h.transport.last);
    expect(message).toContain("OLD-RUNTIME");
    expect(system).toBe("");
    await h.shutdown();
  });

});

describe("the system prompt travels as a file", () => {
  test("so size and special characters are no concern", async () => {
    const h = room();
    h.seed("HUGE <angle> & ampersand | pipe " + "x".repeat(40_000));
    await h.at("wakeup");
    await h.at("__ECHOPROMPT__");
    const { system, message } = channels(h.transport.last);
    expect(system).toContain("HUGE <angle> & ampersand | pipe");
    expect(system.length).toBeGreaterThan(40_000);
    expect(message).not.toContain("HUGE");
    await h.shutdown();
  });
});
