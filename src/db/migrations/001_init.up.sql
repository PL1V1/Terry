-- Room state: one row per (guild, channel). Sessions are keyed by BOTH so that
-- unrelated rooms can never share a coding conversation.
CREATE TABLE rooms (
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'asleep' CHECK (state IN ('asleep', 'awake')),
  session_id    TEXT,
  model         TEXT,
  effort        TEXT,
  activity_mode TEXT NOT NULL DEFAULT 'auto' CHECK (activity_mode IN ('auto', 'custom')),
  activity_text TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (guild_id, channel_id)
);

-- Retired conversation mappings. `new session` never deletes a thread; it
-- files the old session id here so it stays resumable.
CREATE TABLE session_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  retired_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_session_history_room ON session_history (guild_id, channel_id, retired_at DESC);

-- Gateway event de-duplication. Discord replays events across RESUME; a replayed
-- message must never be executed twice.
CREATE TABLE processed_events (
  event_key TEXT PRIMARY KEY,
  seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_processed_events_seen_at ON processed_events (seen_at);
