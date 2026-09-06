-- Reusable instruction registry. Instructions are selected by key and loaded on
-- each turn. Scope precedence is global < guild < channel; the most specific
-- row for a key wins. Populated only with instructions Paul supplies.
CREATE TABLE instructions (
  key        TEXT NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('global', 'guild', 'channel')),
  scope_id   TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  required   INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (key, scope, scope_id)
);

-- Which instruction keys a room loads, in order.
CREATE TABLE room_instructions (
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, key)
);

CREATE INDEX idx_room_instructions_order ON room_instructions (guild_id, channel_id, position);
