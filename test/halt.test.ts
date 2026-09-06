/**
 * The halt sentinel.
 *
 * A fatal gateway close used to log and return, leaving the process alive and
 * disconnected for ever: the scheduler saw it as running and never restarted
 * it, and from Discord it looked like a bot that had gone invisible. Had it
 * exited non-zero instead, the scheduler would have restarted it into the same
 * rejection every minute, 999 times. Neither is acceptable. The sentinel is how
 * the service stops and STAYS stopped, on purpose, with the reason written down.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearHalt, haltPath, readHalt, writeHalt } from "../src/halt.ts";
import { Gateway } from "../src/discord/gateway.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "terry-halt-"));
}

describe("halt sentinel - the file", () => {
  test("absent by default", () => {
    const dir = scratch();
    expect(readHalt(dir)).toBeNull();
    expect(clearHalt(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test("round-trips what was written", () => {
    const dir = scratch();
    const path = writeHalt({ code: 4004, reason: "token rejected", at: "2026-09-06T00:00:00Z" }, dir);
    expect(path).toBe(haltPath(dir));
    expect(readHalt(dir)).toEqual({ code: 4004, reason: "token rejected", at: "2026-09-06T00:00:00Z" });
    rmSync(dir, { recursive: true });
  });

  test("clearing it is what allows a start again", () => {
    const dir = scratch();
    writeHalt({ code: null, reason: "OPERATORS is empty", at: "" }, dir);
    expect(clearHalt(dir)).toBe(true);
    expect(readHalt(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("a sentinel that cannot be parsed still halts", () => {
    // Its presence is the signal; its contents are only the explanation.
    const dir = scratch();
    require("node:fs").writeFileSync(haltPath(dir), "not json");
    const halt = readHalt(dir);
    expect(halt).not.toBeNull();
    expect(halt!.reason).toMatch(/unreadable/);
    rmSync(dir, { recursive: true });
  });

  test("the data directory is created if it does not exist yet", () => {
    const dir = join(scratch(), "nested", "data");
    writeHalt({ code: 4014, reason: "intent not granted", at: "" }, dir);
    expect(readHalt(dir)?.code).toBe(4014);
    rmSync(join(dir, "..", ".."), { recursive: true });
  });
});

describe("halt sentinel - the gateway", () => {
  const handlers = (onFatal: (code: number) => void) => ({
    onMessage: () => {},
    onReady: () => {},
    onConnectionState: () => {},
    onFatal,
  });

  /** scheduleReconnect is private; a test reaches it deliberately. */
  type Reconnectable = { scheduleReconnect(code: number): Promise<void> };

  test("every fatal close code reaches the handler", async () => {
    for (const code of Gateway.FATAL_CLOSE_CODES) {
      const seen: number[] = [];
      const gateway = new Gateway("a-token", handlers((c) => seen.push(c)));
      await (gateway as unknown as Reconnectable).scheduleReconnect(code);
      expect(seen).toEqual([code]);
    }
  });

  test("a resumable close does not", () => {
    const seen: number[] = [];
    const gateway = new Gateway("a-token", handlers((c) => seen.push(c)));
    gateway.close();
    // Not awaited: a non-fatal close schedules a backoff sleep, and closing
    // first makes the eventual reconnect a no-op.
    void (gateway as unknown as Reconnectable).scheduleReconnect(4000);
    expect(seen).toEqual([]);
  });

  test("the handler is optional, so existing callers are unaffected", async () => {
    const gateway = new Gateway("a-token", {
      onMessage: () => {},
      onReady: () => {},
      onConnectionState: () => {},
    });
    await expect((gateway as unknown as Reconnectable).scheduleReconnect(4004)).resolves.toBeUndefined();
  });
});
