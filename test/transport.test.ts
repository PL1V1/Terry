import { describe, expect, test } from "bun:test";
import { chunk, MAX_MESSAGE } from "../src/discord/rest.ts";
import { Gateway } from "../src/discord/gateway.ts";
import { isAuthorised } from "../src/index.ts";
import { loadConfig } from "../src/config.ts";
import type { DiscordMessage } from "../src/discord/gateway.ts";
import type { Config } from "../src/config.ts";

describe("message chunking", () => {
  test("short text is one piece", () => {
    expect(chunk("hello")).toEqual(["hello"]);
  });

  test("empty text produces nothing to send", () => {
    expect(chunk("")).toEqual([]);
  });

  test("every piece respects the Discord limit", () => {
    const text = "word ".repeat(2000);
    for (const piece of chunk(text)) {
      expect(piece.length).toBeLessThanOrEqual(MAX_MESSAGE);
    }
  });

  test("splitting prefers paragraph boundaries", () => {
    const paragraph = "a".repeat(1500);
    const pieces = chunk(`${paragraph}\n\n${paragraph}`);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toBe(paragraph);
    expect(pieces[1]).toBe(paragraph);
  });

  test("a split code block is re-fenced on both sides", () => {
    const body = "x".repeat(2500);
    const pieces = chunk("```\n" + body + "\n```");
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      // An odd number of fences would leave the block open.
      expect((piece.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  test("no content is lost when splitting on words", () => {
    const text = "word ".repeat(1000).trim();
    expect(chunk(text).join(" ")).toBe(text);
  });
});

describe("gateway reconnection policy", () => {
  test("authentication failures are fatal and never retried", () => {
    expect(Gateway.FATAL_CLOSE_CODES.has(4004)).toBe(true);
    expect(Gateway.FATAL_CLOSE_CODES.has(4014)).toBe(true);
  });

  test("a transient close is not fatal", () => {
    expect(Gateway.FATAL_CLOSE_CODES.has(1006)).toBe(false);
    expect(Gateway.FATAL_CLOSE_CODES.has(4902)).toBe(false);
  });

  test("invalid sequence and session timeout force a re-identify", () => {
    expect(Gateway.NON_RESUMABLE.has(4007)).toBe(true);
    expect(Gateway.NON_RESUMABLE.has(4009)).toBe(true);
  });

  test("backoff grows and stays bounded", () => {
    const gateway = new Gateway("token", {
      onMessage: () => {},
      onReady: () => {},
      onConnectionState: () => {},
    });
    const first = gateway.backoffFor(1);
    const later = gateway.backoffFor(10);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(2_000);
    expect(later).toBeLessThanOrEqual(30_000);
    expect(later).toBeGreaterThan(first);
  });
});

const BASE_ENV = {
  DISCORD_TOKEN: "a-token-value-long-enough",
  DISCORD_APPLICATION_ID: "123456789012345678",
  ALLOWED_CHANNELS: "555555555555555555",
  OPERATORS: "777777777777777777",
  ALLOWED_GUILDS: "444444444444444444",
};

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "1",
    channel_id: "555555555555555555",
    guild_id: "444444444444444444",
    content: "hello",
    author: { id: "777777777777777777", username: "paul" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("configuration", () => {
  test("an empty channel allowlist refuses to start", () => {
    expect(() => loadConfig({ ...BASE_ENV, ALLOWED_CHANNELS: "" })).toThrow(/ALLOWED_CHANNELS is empty/);
  });

  test("an empty operator list refuses to start", () => {
    expect(() => loadConfig({ ...BASE_ENV, OPERATORS: "" })).toThrow(/OPERATORS is empty/);
  });

  test("a missing token refuses to start", () => {
    expect(() => loadConfig({ ...BASE_ENV, DISCORD_TOKEN: "" })).toThrow(/DISCORD_TOKEN/);
  });

  test("a malformed id is rejected rather than silently ignored", () => {
    expect(() => loadConfig({ ...BASE_ENV, OPERATORS: "not-a-snowflake" })).toThrow(/not a Discord snowflake/);
  });

  test("defaults fail closed on permissions", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.permissionMode).toBe("plan");
    expect(config.permissionPrompts).toBe("none");
  });
});

describe("authorisation", () => {
  const config: Config = loadConfig(BASE_ENV);

  test("an allowlisted operator in an allowlisted channel is accepted", () => {
    expect(isAuthorised(message(), config).ok).toBe(true);
  });

  test("bots are never task input", () => {
    const verdict = isAuthorised(message({ author: { id: "777777777777777777", username: "b", bot: true } }), config);
    expect(verdict.ok).toBe(false);
  });

  test("webhooks are never task input", () => {
    expect(isAuthorised(message({ webhook_id: "9" }), config).ok).toBe(false);
  });

  test("a stranger in an allowlisted channel is refused", () => {
    const verdict = isAuthorised(message({ author: { id: "888888888888888888", username: "nobody" } }), config);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/operator/);
  });

  test("an operator in a channel that is not allowlisted is refused", () => {
    const verdict = isAuthorised(message({ channel_id: "666666666666666666" }), config);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/channel/);
  });

  test("a message from another guild is refused", () => {
    const verdict = isAuthorised(message({ guild_id: "333333333333333333" }), config);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/guild/);
  });

  test("a direct message is refused", () => {
    const verdict = isAuthorised(message({ guild_id: undefined }), config);
    expect(verdict.ok).toBe(false);
  });
});

describe("restart policy configuration", () => {
  test("a restart returns rooms to asleep by default", () => {
    expect(loadConfig(BASE_ENV).resumeAwakeOnRestart).toBe(false);
  });

  test("staying awake must be opted into explicitly", () => {
    expect(loadConfig({ ...BASE_ENV, RESUME_AWAKE_ON_RESTART: "true" }).resumeAwakeOnRestart).toBe(true);
    expect(loadConfig({ ...BASE_ENV, RESUME_AWAKE_ON_RESTART: "yes" }).resumeAwakeOnRestart).toBe(false);
    expect(loadConfig({ ...BASE_ENV, RESUME_AWAKE_ON_RESTART: "1" }).resumeAwakeOnRestart).toBe(false);
  });
});
