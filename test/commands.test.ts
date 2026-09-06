import { describe, expect, test } from "bun:test";
import { menuText, parseCommand, parseInput } from "../src/controller/commands.ts";

const BOT = "111111111111111111";
const OTHER = "222222222222222222";

describe("parseInput", () => {
  test("recognises a direct mention", () => {
    const result = parseInput(`<@${BOT}> status`, BOT);
    expect(result.mentioned).toBe(true);
    expect(result.command?.name).toBe("status");
  });

  test("accepts the nickname mention form", () => {
    expect(parseInput(`<@!${BOT}> ping`, BOT).command?.name).toBe("ping");
  });

  test("ignores a mention of a different bot", () => {
    const result = parseInput(`<@${OTHER}> sleep`, BOT);
    expect(result.mentioned).toBe(false);
    expect(result.command).toBeNull();
  });

  test("a mention that is not at the start still counts, and is removed from the text", () => {
    // "Sapnin @Terry how's it going" is how people actually write. The old rule
    // dropped it as not addressed, silently, to a real person on the first night.
    const parsed = parseInput(`hello <@${BOT}> there`, BOT);
    expect(parsed.mentioned).toBe(true);
    expect(parsed.text).toBe("hello there");
  });

  test("does not treat ordinary chat as a command", () => {
    const result = parseInput(`<@${BOT}> can you make the tests sleep less`, BOT);
    expect(result.mentioned).toBe(true);
    expect(result.command).toBeNull();
    expect(result.text).toBe("can you make the tests sleep less");
  });

  test("strips the mention from the text", () => {
    expect(parseInput(`<@${BOT}>   fix the auth bug`, BOT).text).toBe("fix the auth bug");
  });
});

describe("parseCommand", () => {
  test("matches two-word commands before single words", () => {
    expect(parseCommand("new session")?.name).toBe("new-session");
    expect(parseCommand("new session confirm")?.name).toBe("confirm-new-session");
    expect(parseCommand("confirm new session")?.name).toBe("confirm-new-session");
    expect(parseCommand("list models")?.name).toBe("list-models");
  });

  test("is case insensitive", () => {
    expect(parseCommand("STATUS")?.name).toBe("status");
    expect(parseCommand("New Session")?.name).toBe("new-session");
  });

  test("captures arguments", () => {
    expect(parseCommand("model opus")).toEqual({ name: "model", arg: "opus" });
    expect(parseCommand("effort high")).toEqual({ name: "effort", arg: "high" });
    expect(parseCommand("activity building the thing")).toEqual({
      name: "activity",
      arg: "building the thing",
    });
  });

  test("effort with no argument is a query, not a change", () => {
    expect(parseCommand("effort")).toEqual({ name: "effort", arg: "" });
  });

  test("returns null for anything unrecognised", () => {
    expect(parseCommand("deploy to production")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});

describe("role mentions", () => {
  const ROLE = "999999999999999999";
  const SELF = new Set([BOT, ROLE]);

  test("a mention of the bot's own managed role addresses the bot", () => {
    // Discord renders <@&roleId> identically to <@botId>. Both are "@Terry".
    const result = parseInput(`<@&${ROLE}> wakeup`, SELF);
    expect(result.mentioned).toBe(true);
    expect(result.command?.name).toBe("wakeup");
  });

  test("a user mention still works alongside it", () => {
    expect(parseInput(`<@${BOT}> status`, SELF).command?.name).toBe("status");
  });

  test("some other role is not us", () => {
    expect(parseInput(`<@&${OTHER}> sleep`, SELF).mentioned).toBe(false);
  });

  test("a bare string self id is still accepted", () => {
    expect(parseInput(`<@${BOT}> ping`, BOT).command?.name).toBe("ping");
    expect(parseInput(`<@&${ROLE}> ping`, BOT).mentioned).toBe(false);
  });
});

describe("menu rendering", () => {
  test("examples use a readable label, never a raw mention", () => {
    const menu = menuText("@Terry");
    expect(menu).toContain("`@Terry wakeup`");
    // A raw <@id> inside a code span renders as literal angle brackets to the
    // reader, which is what made the first version of this menu unusable.
    expect(menu).not.toContain("<@");
  });

  test("every documented command is one the parser accepts", () => {
    const documented = [...menuText("@Terry").matchAll(/`@Terry ([a-z ]+?)(?: <[a-z]+>)?`/g)].map((m) => m[1]!.trim());
    expect(documented.length).toBeGreaterThan(8);
    for (const command of documented) {
      expect(parseCommand(command)).not.toBeNull();
    }
  });
});
