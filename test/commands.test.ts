import { describe, expect, test } from "bun:test";
import { parseCommand, parseInput } from "../src/controller/commands.ts";

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

  test("ignores a mention that is not at the start", () => {
    expect(parseInput(`hello <@${BOT}> sleep`, BOT).mentioned).toBe(false);
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
