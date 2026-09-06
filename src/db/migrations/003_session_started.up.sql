-- Whether this room's conversation has actually been started by the runtime.
--
-- The runtime distinguishes creating a conversation (--session-id) from
-- continuing one (--resume), and rejects the wrong one: reusing an id that
-- exists fails with "Session ID is already in use". Remembering that a
-- conversation has been started is what lets a restart continue it.
ALTER TABLE rooms ADD COLUMN session_started INTEGER NOT NULL DEFAULT 0;

-- Existing rooms with a mapped conversation have been running before this
-- column existed, so their conversations already exist in the runtime.
UPDATE rooms SET session_started = 1 WHERE session_id IS NOT NULL;
