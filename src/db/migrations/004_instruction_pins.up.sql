-- What a conversation was actually told, frozen at the moment it was minted.
--
-- Instructions are otherwise resolved live on every turn. That is deliberate for
-- editing - a fix is visible on the next message with no restart - but it means
-- an edit also rewrites the rules of a conversation that is already running,
-- mid-thread, with nothing said. The conversation cannot tell you its rules
-- changed, because from its side they were always these ones.
--
-- A pin freezes the resolved body and its hash per conversation. Drift then
-- becomes a thing the room can see and report, rather than a thing that happened
-- quietly three days ago.
--
-- Keyed by session_id, so replacing a conversation mints a fresh set and the old
-- pins stay attached to the retired conversation they describe.
CREATE TABLE instruction_pins (
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  scope      TEXT NOT NULL,
  body       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  pinned_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (guild_id, channel_id, session_id, key)
);

CREATE INDEX idx_instruction_pins_order
  ON instruction_pins (guild_id, channel_id, session_id, position);
