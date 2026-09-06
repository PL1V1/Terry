/**
 * The halt sentinel.
 *
 * Some failures can never succeed on retry: Discord rejecting the token, an
 * intent the application was not granted, a configuration the service refuses
 * to run with. Exiting non-zero hands them to the scheduler, which retries every
 * minute for 999 attempts. For a rejected token that is precisely the hammering
 * the stop was meant to prevent; for a bad .env it is a log of the same line.
 *
 * So a failure of that class writes a sentinel and exits zero. The launcher
 * checks for it before starting and declines, saying why. Clearing it is a
 * deliberate act - `bun run src/admin.ts halt clear` - because the cause needs
 * a human before a retry can mean anything.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Halt {
  /** Gateway close code, or null for a refusal that had nothing to do with Discord. */
  code: number | null;
  reason: string;
  at: string;
}

export const HALT_FILE = "halt.json";

export function haltPath(dataDir: string): string {
  return join(dataDir, HALT_FILE);
}

export function writeHalt(halt: Halt, dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = haltPath(dataDir);
  writeFileSync(path, JSON.stringify(halt, null, 2) + "\n");
  return path;
}

export function readHalt(dataDir: string): Halt | null {
  const path = haltPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Halt;
  } catch {
    // A sentinel that cannot be parsed still means "do not start": its
    // presence is the signal, its contents are the explanation.
    return { code: null, reason: "halt sentinel present but unreadable", at: "" };
  }
}

/** Removes the sentinel. True if there was one. */
export function clearHalt(dataDir: string): boolean {
  const path = haltPath(dataDir);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
