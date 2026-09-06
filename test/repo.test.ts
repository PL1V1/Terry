import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateDown, migrateUp, applied } from "../src/db/migrate.ts";
import { Repo } from "../src/db/repo.ts";

const GUILD = "1";
const CHANNEL_A = "10";
const CHANNEL_B = "20";

function fresh(): { db: Database; repo: Repo } {
  const db = new Database(":memory:");
  migrateUp(db);
  return { db, repo: new Repo(db) };
}

describe("migrations", () => {
  test("apply and roll back cleanly", () => {
    const db = new Database(":memory:");
    const up = migrateUp(db);
    expect(up.length).toBeGreaterThan(0);
    expect(applied(db).length).toBe(up.length);

    const rolledBack = migrateDown(db);
    expect(rolledBack).toBe(up.at(-1)!);
    expect(applied(db).length).toBe(up.length - 1);

    // Re-applying must be possible after a rollback.
    expect(migrateUp(db)).toEqual([rolledBack!]);
  });

  test("running up twice applies nothing the second time", () => {
    const db = new Database(":memory:");
    migrateUp(db);
    expect(migrateUp(db)).toEqual([]);
  });
});

describe("rooms", () => {
  let repo: Repo;
  beforeEach(() => {
    repo = fresh().repo;
  });

  test("a new room starts asleep with no conversation", () => {
    const room = repo.ensureRoom(GUILD, CHANNEL_A);
    expect(room.state).toBe("asleep");
    expect(room.session_id).toBeNull();
    expect(room.activity_mode).toBe("auto");
  });

  test("two channels in one guild stay isolated", () => {
    repo.ensureRoom(GUILD, CHANNEL_A);
    repo.ensureRoom(GUILD, CHANNEL_B);
    repo.setSession(GUILD, CHANNEL_A, "session-a");
    repo.setModel(GUILD, CHANNEL_A, "opus");
    repo.setState(GUILD, CHANNEL_A, "awake");

    const b = repo.getRoom(GUILD, CHANNEL_B)!;
    expect(b.session_id).toBeNull();
    expect(b.model).toBeNull();
    expect(b.state).toBe("asleep");
  });

  test("the same channel id in a different guild is a different room", () => {
    repo.ensureRoom(GUILD, CHANNEL_A);
    repo.setSession(GUILD, CHANNEL_A, "session-a");
    repo.ensureRoom("999", CHANNEL_A);
    expect(repo.getRoom("999", CHANNEL_A)!.session_id).toBeNull();
  });

  test("preferences survive being read back", () => {
    repo.ensureRoom(GUILD, CHANNEL_A);
    repo.setModel(GUILD, CHANNEL_A, "sonnet");
    repo.setEffort(GUILD, CHANNEL_A, "high");
    repo.setActivity(GUILD, CHANNEL_A, "custom", "on the tools");

    const room = repo.getRoom(GUILD, CHANNEL_A)!;
    expect(room.model).toBe("sonnet");
    expect(room.effort).toBe("high");
    expect(room.activity_mode).toBe("custom");
    expect(room.activity_text).toBe("on the tools");
  });
});

describe("session history", () => {
  test("retiring a session preserves it and clears the mapping", () => {
    const { repo } = fresh();
    repo.ensureRoom(GUILD, CHANNEL_A);
    repo.setSession(GUILD, CHANNEL_A, "old-session");

    const retired = repo.retireSession(GUILD, CHANNEL_A, "new session requested");
    expect(retired).toBe("old-session");
    expect(repo.getRoom(GUILD, CHANNEL_A)!.session_id).toBeNull();

    const history = repo.retiredSessions(GUILD, CHANNEL_A);
    expect(history).toHaveLength(1);
    expect(history[0]!.session_id).toBe("old-session");
  });

  test("retiring with no session is a no-op", () => {
    const { repo } = fresh();
    repo.ensureRoom(GUILD, CHANNEL_A);
    expect(repo.retireSession(GUILD, CHANNEL_A, "none")).toBeNull();
    expect(repo.retiredSessions(GUILD, CHANNEL_A)).toHaveLength(0);
  });
});

describe("event de-duplication", () => {
  test("the first sighting wins and replays are rejected", () => {
    const { repo } = fresh();
    expect(repo.markEventSeen("message:1")).toBe(true);
    expect(repo.markEventSeen("message:1")).toBe(false);
    expect(repo.markEventSeen("message:2")).toBe(true);
  });

  test("pruning removes only old keys", () => {
    const { db, repo } = fresh();
    repo.markEventSeen("recent");
    db.query(
      "INSERT INTO processed_events (event_key, seen_at) VALUES ('ancient', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-100 hours'))",
    ).run();

    expect(repo.pruneEvents(48)).toBe(1);
    expect(repo.markEventSeen("recent")).toBe(false);
    expect(repo.markEventSeen("ancient")).toBe(true);
  });
});

describe("instruction registry", () => {
  test("the most specific scope wins", () => {
    const { repo } = fresh();
    repo.upsertInstruction({ key: "voice", scope: "global", scope_id: "", body: "global body" });
    expect(repo.resolveInstruction("voice", GUILD, CHANNEL_A)!.body).toBe("global body");

    repo.upsertInstruction({ key: "voice", scope: "guild", scope_id: GUILD, body: "guild body" });
    expect(repo.resolveInstruction("voice", GUILD, CHANNEL_A)!.body).toBe("guild body");

    repo.upsertInstruction({ key: "voice", scope: "channel", scope_id: CHANNEL_A, body: "channel body" });
    expect(repo.resolveInstruction("voice", GUILD, CHANNEL_A)!.body).toBe("channel body");

    // The narrower override must not leak into a different channel.
    expect(repo.resolveInstruction("voice", GUILD, CHANNEL_B)!.body).toBe("guild body");
  });

  test("an unknown key resolves to nothing", () => {
    const { repo } = fresh();
    expect(repo.resolveInstruction("missing", GUILD, CHANNEL_A)).toBeNull();
  });

  test("required is visible so a missing entry can be reported", () => {
    const { repo } = fresh();
    repo.upsertInstruction({ key: "house", scope: "global", scope_id: "", body: "x", required: true });
    expect(repo.isRequired("house")).toBe(true);
    expect(repo.isRequired("optional")).toBe(false);
  });

  test("room instruction keys keep their order", () => {
    const { repo } = fresh();
    repo.setRoomInstructions(GUILD, CHANNEL_A, ["first", "second", "third"]);
    expect(repo.roomInstructionKeys(GUILD, CHANNEL_A)).toEqual(["first", "second", "third"]);

    repo.setRoomInstructions(GUILD, CHANNEL_A, ["only"]);
    expect(repo.roomInstructionKeys(GUILD, CHANNEL_A)).toEqual(["only"]);
  });

  test("upsert replaces the body rather than duplicating the row", () => {
    const { repo } = fresh();
    repo.upsertInstruction({ key: "k", scope: "global", scope_id: "", body: "one" });
    repo.upsertInstruction({ key: "k", scope: "global", scope_id: "", body: "two" });
    expect(repo.resolveInstruction("k", GUILD, CHANNEL_A)!.body).toBe("two");
  });
});

describe("restart policy", () => {
  test("awake rooms are found and returned to asleep", () => {
    const { repo } = fresh();
    repo.ensureRoom(GUILD, CHANNEL_A);
    repo.ensureRoom(GUILD, CHANNEL_B);
    repo.setState(GUILD, CHANNEL_A, "awake");
    repo.setSession(GUILD, CHANNEL_A, "keep-me");
    repo.setModel(GUILD, CHANNEL_A, "opus");

    expect(repo.awakeRooms()).toHaveLength(1);
    expect(repo.sleepAllRooms()).toBe(1);

    const room = repo.getRoom(GUILD, CHANNEL_A)!;
    expect(room.state).toBe("asleep");
    // The mapping and preferences must survive; only the state changes.
    expect(room.session_id).toBe("keep-me");
    expect(room.model).toBe("opus");
  });

  test("sleeping when nothing is awake changes nothing", () => {
    const { repo } = fresh();
    repo.ensureRoom(GUILD, CHANNEL_A);
    expect(repo.awakeRooms()).toHaveLength(0);
    expect(repo.sleepAllRooms()).toBe(0);
  });
});
