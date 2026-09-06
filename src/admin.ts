/**
 * Operator CLI for the instruction registry and room state.
 *
 * Deliberately a local, on-the-machine tool: instructions and preferences are
 * changed here, never from a Discord message.
 */
import { openDatabase } from "./db/index.ts";
import { migrateUp } from "./db/migrate.ts";
import { Repo } from "./db/repo.ts";
import { clearHalt, readHalt } from "./halt.ts";
import { hashBody, type Instruction } from "./controller/pins.ts";
import { dirname } from "node:path";

const USAGE = `Terry admin

  bun run src/admin.ts <command>

Instructions
  instructions list
  instruction show <key>
  instruction set <key> --body-file <path> [--scope global|guild|channel]
                        [--scope-id <id>] [--required]
  instruction rm  <key> --scope <scope> [--scope-id <id>]

Halt
  halt show                  why the service is declining to start, if it is
  halt clear                 allow it to start again

Rooms
  rooms
  room show     <guildId> <channelId>
  room use      <guildId> <channelId> <key,key,...>   set instruction keys
  room sleep    <guildId> <channelId>
  room accept   <guildId> <channelId>   re-pin its conversation to the registry as it is now
  room history  <guildId> <channelId>

The database is taken from DATABASE_PATH (default ./data/terry.sqlite).
`;

interface Flags {
  positional: string[];
  named: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const named: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        named[key] = next;
        i += 1;
      } else {
        named[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, named };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { positional, named } = parseArgs(Bun.argv.slice(2));
  if (positional.length === 0 || named.help) {
    console.log(USAGE);
    return;
  }

  const dbPath = Bun.env.DATABASE_PATH?.trim() || "./data/terry.sqlite";

  const [group0, action0] = positional;
  if (group0 === "halt") {
    // Handled before the database opens: this must work when the service
    // cannot start, and the database is one of the things that may be wrong.
    const dir = dirname(dbPath);
    if (action0 === "clear") {
      console.log(
        clearHalt(dir)
          ? "Halt sentinel cleared. The service will start on its next launch."
          : "No halt sentinel to clear.",
      );
      return;
    }
    const halt = readHalt(dir);
    if (!halt) {
      console.log("No halt sentinel. The service will start normally.");
      return;
    }
    console.log(`The service is declining to start. Written :`);
    console.log(`  reason : `);
    if (halt.code !== null) console.log(`  code   : `);
    console.log(`Fix the cause, then: bun run src/admin.ts halt clear`);
    return;
  }

  const db = openDatabase(dbPath);
  migrateUp(db);
  const repo = new Repo(db);

  const [group, action, ...rest] = positional;

  try {
    if (group === "instructions" && (action === "list" || action === undefined)) {
      const rows = db
        .query<{ key: string; scope: string; scope_id: string; required: number; updated_at: string }, []>(
          "SELECT key, scope, scope_id, required, updated_at FROM instructions ORDER BY key, scope",
        )
        .all();
      if (rows.length === 0) {
        console.log("The registry is empty. Nothing is loaded into any room.");
        return;
      }
      for (const row of rows) {
        const scope = row.scope_id ? `${row.scope}:${row.scope_id}` : row.scope;
        console.log(`${row.key}\t${scope}\t${row.required ? "required" : "optional"}\t${row.updated_at}`);
      }
      return;
    }

    if (group === "instruction" && action === "show") {
      const key = rest[0] ?? fail("instruction show needs a key");
      const rows = db
        .query<{ scope: string; scope_id: string; body: string }, [string]>(
          "SELECT scope, scope_id, body FROM instructions WHERE key = ? ORDER BY scope",
        )
        .all(key);
      if (rows.length === 0) fail(`no instruction with key '${key}'`);
      for (const row of rows) {
        console.log(`--- ${key} [${row.scope}${row.scope_id ? `:${row.scope_id}` : ""}] ---`);
        console.log(row.body);
      }
      return;
    }

    if (group === "instruction" && action === "set") {
      const key = rest[0] ?? fail("instruction set needs a key");
      const bodyFile = named["body-file"];
      if (typeof bodyFile !== "string") fail("instruction set needs --body-file <path>");
      const body = await Bun.file(bodyFile).text();
      if (!body.trim()) fail(`${bodyFile} is empty`);

      const scope = (typeof named.scope === "string" ? named.scope : "global") as "global" | "guild" | "channel";
      if (!["global", "guild", "channel"].includes(scope)) fail(`unknown scope '${scope}'`);
      const scopeId = typeof named["scope-id"] === "string" ? named["scope-id"] : "";
      if (scope !== "global" && !scopeId) fail(`scope '${scope}' needs --scope-id`);

      repo.upsertInstruction({ key, scope, scope_id: scopeId, body, required: named.required === true });
      console.log(`Stored '${key}' at scope ${scope}${scopeId ? `:${scopeId}` : ""} (${body.length} chars).`);
      return;
    }

    if (group === "instruction" && action === "rm") {
      const key = rest[0] ?? fail("instruction rm needs a key");
      const scope = typeof named.scope === "string" ? named.scope : fail("instruction rm needs --scope");
      const scopeId = typeof named["scope-id"] === "string" ? named["scope-id"] : "";
      const result = db
        .query("DELETE FROM instructions WHERE key = ? AND scope = ? AND scope_id = ?")
        .run(key, scope, scopeId);
      console.log(result.changes ? `Removed '${key}'.` : "Nothing matched.");
      return;
    }

    if (group === "rooms") {
      const rows = db
        .query<{ guild_id: string; channel_id: string; state: string; session_id: string | null; model: string | null; effort: string | null }, []>(
          "SELECT guild_id, channel_id, state, session_id, model, effort FROM rooms ORDER BY guild_id, channel_id",
        )
        .all();
      if (rows.length === 0) {
        console.log("No rooms yet.");
        return;
      }
      for (const row of rows) {
        console.log(
          `${row.guild_id}/${row.channel_id}\t${row.state}\tsession=${row.session_id ?? "-"}\tmodel=${row.model ?? "-"}\teffort=${row.effort ?? "-"}`,
        );
      }
      return;
    }

    if (group === "room") {
      const guildId = rest[0] ?? fail("room commands need a guild id");
      const channelId = rest[1] ?? fail("room commands need a channel id");

      if (action === "show") {
        const room = repo.getRoom(guildId, channelId);
        if (!room) fail("no such room");
        console.log(JSON.stringify(room, null, 2));
        console.log("instruction keys:", repo.roomInstructionKeys(guildId, channelId).join(", ") || "(none)");
        return;
      }
      if (action === "use") {
        const keys = (rest[2] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
        repo.ensureRoom(guildId, channelId);
        repo.setRoomInstructions(guildId, channelId, keys);
        console.log(`Room ${guildId}/${channelId} now loads: ${keys.join(", ") || "(none)"}`);
        return;
      }
      if (action === "sleep") {
        repo.ensureRoom(guildId, channelId);
        repo.setState(guildId, channelId, "asleep");
        console.log("Room set to asleep.");
        return;
      }
      if (action === "accept") {
        // The same re-pin `accept instructions` does from chat, for an operator at
        // a terminal - so a registry change can be adopted without a room round-trip.
        const room = repo.getRoom(guildId, channelId);
        if (!room?.session_id) fail("this room has no conversation to pin");
        const minted: Instruction[] = [];
        for (const key of repo.roomInstructionKeys(guildId, channelId)) {
          const row = repo.resolveInstruction(key, guildId, channelId);
          if (row) minted.push({ key: row.key, scope: row.scope, body: row.body, sha256: hashBody(row.body) });
        }
        repo.pinInstructions(guildId, channelId, room.session_id, minted);
        console.log(`Conversation ${room.session_id} re-pinned to: ${minted.map((m) => m.key).join(", ") || "(nothing)"}. Takes effect on its next turn.`);
        return;
      }
      if (action === "history") {
        const history = repo.retiredSessions(guildId, channelId, 25);
        if (history.length === 0) {
          console.log("No retired conversations.");
          return;
        }
        for (const row of history) console.log(`${row.retired_at}\t${row.session_id}\t${row.reason}`);
        return;
      }
    }

    console.log(USAGE);
    process.exit(2);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
