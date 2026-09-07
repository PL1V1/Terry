/**
 * The `export` subcommand's table read must represent one consistent point in
 * time, even though it reads seven tables one after another. Under WAL mode a
 * writer can commit between two of those reads; without a shared transaction
 * the export would mix pre- and post-write state across tables.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { migrateUp } from "../src/db/migrate.ts";
import { openDatabase } from "../src/db/index.ts";
import { readExportTables } from "../src/admin.ts";

describe("readExportTables", () => {
  test("returns every table with the rows seeded in it", () => {
    const db = new Database(":memory:");
    migrateUp(db);

    db.query(
      "INSERT INTO rooms (guild_id, channel_id, state, session_id) VALUES (?, ?, ?, ?)",
    ).run("g", "c", "awake", "sess-1");
    db.query(
      "INSERT INTO session_history (guild_id, channel_id, session_id, reason) VALUES (?, ?, ?, ?)",
    ).run("g", "c", "sess-0", "new session requested");
    db.query("INSERT INTO processed_events (event_key) VALUES (?)").run("evt-1");
    db.query(
      "INSERT INTO instructions (key, scope, scope_id, body) VALUES (?, ?, ?, ?)",
    ).run("greeting", "global", "", "hello");
    db.query(
      "INSERT INTO room_instructions (guild_id, channel_id, key, position) VALUES (?, ?, ?, ?)",
    ).run("g", "c", "greeting", 0);
    db.query(
      "INSERT INTO instruction_pins (guild_id, channel_id, session_id, key, scope, body, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("g", "c", "sess-1", "greeting", "global", "hello", "deadbeef");

    const tables = readExportTables(db);

    expect(Object.keys(tables).sort()).toEqual(
      [
        "rooms",
        "session_history",
        "processed_events",
        "instructions",
        "room_instructions",
        "instruction_pins",
        "schema_migrations",
      ].sort(),
    );
    expect(tables.rooms).toHaveLength(1);
    expect(tables.session_history).toHaveLength(1);
    expect(tables.processed_events).toHaveLength(1);
    expect(tables.instructions).toHaveLength(1);
    expect(tables.room_instructions).toHaveLength(1);
    expect(tables.instruction_pins).toHaveLength(1);
    expect(tables.schema_migrations!.length).toBeGreaterThan(0);
  });

  test("represents one consistent snapshot even when a writer commits mid-read", () => {
    const path = join(tmpdir(), `terry-admin-test-${randomUUID()}.sqlite`);
    const writer = openDatabase(path);
    migrateUp(writer);

    writer.query(
      "INSERT INTO rooms (guild_id, channel_id, state, session_id) VALUES (?, ?, ?, ?)",
    ).run("g", "before", "awake", "sess-1");
    writer.query(
      "INSERT INTO instructions (key, scope, scope_id, body) VALUES (?, ?, ?, ?)",
    ).run("before", "global", "", "seeded before the export snapshot");

    const reader = new Database(path);

    try {
      // Manually drive the same BEGIN DEFERRED -> read -> ... -> COMMIT shape
      // readExportTables uses, so a write can be interleaved between two of
      // its reads - which calling readExportTables as a black box, in one
      // synchronous call, would not let this test do.
      reader.exec("BEGIN DEFERRED");
      const roomsAtSnapshot = reader.query("SELECT * FROM rooms").all();

      // Committed by a second connection after the reader's snapshot is
      // already locked in, but before the reader has read every table.
      writer.query(
        "INSERT INTO rooms (guild_id, channel_id, state, session_id) VALUES (?, ?, ?, ?)",
      ).run("g", "after", "awake", "sess-2");
      writer.query(
        "INSERT INTO instructions (key, scope, scope_id, body) VALUES (?, ?, ?, ?)",
      ).run("after", "global", "", "written during the export");

      const instructionsAtSnapshot = reader.query("SELECT * FROM instructions").all();
      reader.exec("COMMIT");

      expect(roomsAtSnapshot).toHaveLength(1);
      expect(instructionsAtSnapshot).toHaveLength(1);
      expect((instructionsAtSnapshot[0] as { key: string }).key).toBe("before");

      // The concurrent write is real and visible to a fresh read afterwards -
      // it just must not have leaked into the snapshot taken above.
      const roomsAfterCommit = reader.query("SELECT * FROM rooms").all();
      expect(roomsAfterCommit).toHaveLength(2);
    } finally {
      reader.close();
      writer.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
