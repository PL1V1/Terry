import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./index.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  applied_at: string;
}

/**
 * Reads migrations/NNN_name.up.sql plus its matching .down.sql. A missing down
 * file is a hard error: an irreversible migration is a trap, not a shortcut.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".up.sql"));
  const migrations = files.map((file) => {
    const match = /^(\d+)_(.+)\.up\.sql$/.exec(file);
    if (!match) throw new Error(`Migration filename is not NNN_name.up.sql: ${file}`);
    const version = Number.parseInt(match[1]!, 10);
    const name = match[2]!;
    const downFile = `${match[1]}_${name}.down.sql`;
    let down: string;
    try {
      down = readFileSync(join(dir, downFile), "utf8");
    } catch {
      throw new Error(`Migration ${file} has no matching ${downFile}; migrations must be reversible`);
    }
    return { version, name, up: readFileSync(join(dir, file), "utf8"), down };
  });

  migrations.sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) throw new Error(`Duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
  return migrations;
}

function ensureTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

export function applied(db: Database): AppliedMigration[] {
  ensureTable(db);
  return db.query<AppliedMigration, []>("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
}

/** Applies every pending migration in order. Returns the versions applied. */
export function migrateUp(db: Database, dir?: string): number[] {
  ensureTable(db);
  const done = new Set(applied(db).map((r) => r.version));
  const pending = loadMigrations(dir).filter((m) => !done.has(m.version));
  const run = db.transaction((migrations: Migration[]) => {
    for (const m of migrations) {
      db.exec(m.up);
      db.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
    }
  });
  run(pending);
  return pending.map((m) => m.version);
}

/** Rolls back the single most recent migration. Returns its version, or null. */
export function migrateDown(db: Database, dir?: string): number | null {
  ensureTable(db);
  const done = applied(db);
  const last = done.at(-1);
  if (!last) return null;
  const migration = loadMigrations(dir).find((m) => m.version === last.version);
  if (!migration) throw new Error(`Applied migration ${last.version} has no file to roll back with`);
  const run = db.transaction(() => {
    db.exec(migration.down);
    db.query("DELETE FROM schema_migrations WHERE version = ?").run(migration.version);
  });
  run();
  return migration.version;
}

if (import.meta.main) {
  const command = Bun.argv[2] ?? "up";
  const path = Bun.env.DATABASE_PATH?.trim() || "./data/terry.sqlite";
  const db = openDatabase(path);
  try {
    if (command === "up") {
      const versions = migrateUp(db);
      console.log(versions.length ? `Applied: ${versions.join(", ")}` : "Already up to date.");
    } else if (command === "down") {
      const version = migrateDown(db);
      console.log(version === null ? "Nothing to roll back." : `Rolled back ${version}.`);
    } else if (command === "status") {
      const done = new Set(applied(db).map((r) => r.version));
      for (const m of loadMigrations()) {
        console.log(`${done.has(m.version) ? "applied" : "pending"}\t${m.version}\t${m.name}`);
      }
    } else {
      console.error(`Unknown command '${command}'. Use up, down or status.`);
      process.exit(2);
    }
  } finally {
    db.close();
  }
}
