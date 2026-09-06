import type { Database } from "bun:sqlite";

export type RoomState = "asleep" | "awake";
export type ActivityMode = "auto" | "custom";

export interface Room {
  guild_id: string;
  channel_id: string;
  state: RoomState;
  session_id: string | null;
  model: string | null;
  effort: string | null;
  activity_mode: ActivityMode;
  activity_text: string | null;
  /** 1 once the runtime has actually created this conversation. */
  session_started: number;
}

export interface RetiredSession {
  session_id: string;
  reason: string;
  retired_at: string;
}

export interface InstructionRow {
  key: string;
  scope: "global" | "guild" | "channel";
  scope_id: string;
  body: string;
  required: number;
}

const SCOPE_RANK = { global: 0, guild: 1, channel: 2 } as const;

export class Repo {
  constructor(private readonly db: Database) {}

  /** Fetches a room, creating the default asleep row on first sight. */
  ensureRoom(guildId: string, channelId: string): Room {
    this.db
      .query("INSERT OR IGNORE INTO rooms (guild_id, channel_id) VALUES (?, ?)")
      .run(guildId, channelId);
    return this.getRoom(guildId, channelId)!;
  }

  getRoom(guildId: string, channelId: string): Room | null {
    return this.db
      .query<Room, [string, string]>(
        `SELECT guild_id, channel_id, state, session_id, model, effort, activity_mode, activity_text, session_started
         FROM rooms WHERE guild_id = ? AND channel_id = ?`,
      )
      .get(guildId, channelId);
  }

  private update(guildId: string, channelId: string, column: string, value: string | null): void {
    this.db
      .query(
        `UPDATE rooms SET ${column} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE guild_id = ? AND channel_id = ?`,
      )
      .run(value, guildId, channelId);
  }

  setState(guildId: string, channelId: string, state: RoomState): void {
    this.update(guildId, channelId, "state", state);
  }

  /**
   * Points the room at a conversation id. A newly assigned id has not been
   * created in the runtime yet, so the started flag resets with it.
   */
  setSession(guildId: string, channelId: string, sessionId: string | null): void {
    this.db
      .query(
        `UPDATE rooms SET session_id = ?, session_started = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE guild_id = ? AND channel_id = ?`,
      )
      .run(sessionId, guildId, channelId);
  }

  /** Records that the runtime has created this room's conversation. */
  markSessionStarted(guildId: string, channelId: string): void {
    this.update(guildId, channelId, "session_started", "1");
  }

  setModel(guildId: string, channelId: string, model: string | null): void {
    this.update(guildId, channelId, "model", model);
  }

  setEffort(guildId: string, channelId: string, effort: string | null): void {
    this.update(guildId, channelId, "effort", effort);
  }

  setActivity(guildId: string, channelId: string, mode: ActivityMode, text: string | null): void {
    this.db
      .query(
        `UPDATE rooms SET activity_mode = ?, activity_text = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE guild_id = ? AND channel_id = ?`,
      )
      .run(mode, text, guildId, channelId);
  }

  /**
   * Files the room's current session in history and clears the mapping. The old
   * conversation is never deleted, so it stays resumable by id.
   */
  retireSession(guildId: string, channelId: string, reason: string): string | null {
    const room = this.getRoom(guildId, channelId);
    const sessionId = room?.session_id ?? null;
    if (!sessionId) return null;
    const run = this.db.transaction(() => {
      this.db
        .query("INSERT INTO session_history (guild_id, channel_id, session_id, reason) VALUES (?, ?, ?, ?)")
        .run(guildId, channelId, sessionId, reason);
      this.update(guildId, channelId, "session_id", null);
    });
    run();
    return sessionId;
  }

  /** Rooms currently marked awake. */
  awakeRooms(): Room[] {
    return this.db
      .query<Room, []>(
        `SELECT guild_id, channel_id, state, session_id, model, effort, activity_mode, activity_text, session_started
         FROM rooms WHERE state = 'awake'`,
      )
      .all();
  }

  /**
   * Returns every room to asleep, leaving conversation mappings and preferences
   * untouched. Used on startup so a restart does not silently resume work.
   */
  sleepAllRooms(): number {
    const result = this.db
      .query(
        `UPDATE rooms SET state = 'asleep', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE state = 'awake'`,
      )
      .run();
    return result.changes;
  }

  retiredSessions(guildId: string, channelId: string, limit = 10): RetiredSession[] {
    return this.db
      .query<RetiredSession, [string, string, number]>(
        `SELECT session_id, reason, retired_at FROM session_history
         WHERE guild_id = ? AND channel_id = ? ORDER BY retired_at DESC LIMIT ?`,
      )
      .all(guildId, channelId, limit);
  }

  /**
   * Records a Gateway event key. Returns true the first time a key is seen and
   * false for replays, so a resumed connection cannot execute work twice.
   */
  markEventSeen(eventKey: string): boolean {
    const result = this.db
      .query("INSERT OR IGNORE INTO processed_events (event_key) VALUES (?)")
      .run(eventKey);
    return result.changes > 0;
  }

  /** Drops de-duplication keys older than the given age. */
  pruneEvents(olderThanHours = 48): number {
    const result = this.db
      .query("DELETE FROM processed_events WHERE seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)")
      .run(`-${olderThanHours} hours`);
    return result.changes;
  }

  upsertInstruction(row: Omit<InstructionRow, "required"> & { required?: boolean }): void {
    this.db
      .query(
        `INSERT INTO instructions (key, scope, scope_id, body, required, updated_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (key, scope, scope_id)
         DO UPDATE SET body = excluded.body, required = excluded.required, updated_at = excluded.updated_at`,
      )
      .run(row.key, row.scope, row.scope_id, row.body, row.required ? 1 : 0);
  }

  setRoomInstructions(guildId: string, channelId: string, keys: string[]): void {
    const run = this.db.transaction(() => {
      this.db.query("DELETE FROM room_instructions WHERE guild_id = ? AND channel_id = ?").run(guildId, channelId);
      keys.forEach((key, index) => {
        this.db
          .query("INSERT INTO room_instructions (guild_id, channel_id, key, position) VALUES (?, ?, ?, ?)")
          .run(guildId, channelId, key, index);
      });
    });
    run();
  }

  roomInstructionKeys(guildId: string, channelId: string): string[] {
    return this.db
      .query<{ key: string }, [string, string]>(
        "SELECT key FROM room_instructions WHERE guild_id = ? AND channel_id = ? ORDER BY position, key",
      )
      .all(guildId, channelId)
      .map((r) => r.key);
  }

  /**
   * Resolves one instruction key for a room. Scope precedence is
   * global < guild < channel; the most specific matching row wins.
   */
  resolveInstruction(key: string, guildId: string, channelId: string): InstructionRow | null {
    const rows = this.db
      .query<InstructionRow, [string, string, string]>(
        `SELECT key, scope, scope_id, body, required FROM instructions
         WHERE key = ? AND (
           (scope = 'global')
           OR (scope = 'guild'   AND scope_id = ?)
           OR (scope = 'channel' AND scope_id = ?)
         )`,
      )
      .all(key, guildId, channelId);
    if (rows.length === 0) return null;
    return rows.reduce((best, row) => (SCOPE_RANK[row.scope] > SCOPE_RANK[best.scope] ? row : best));
  }

  /** True if any row for this key is marked required at any scope. */
  isRequired(key: string): boolean {
    const row = this.db
      .query<{ n: number }, [string]>("SELECT MAX(required) AS n FROM instructions WHERE key = ?")
      .get(key);
    return (row?.n ?? 0) === 1;
  }
}
