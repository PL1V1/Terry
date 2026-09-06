/**
 * Version-pinned instructions.
 *
 * Modelled on context-pack: each component of the packet is pinned by content
 * hash with a frozen copy, and a live file that has moved past its pin is drift
 * - reported, not silently adopted.
 *
 * The whole of the decision lives in `planPacket`, which is pure: it takes what
 * the registry says now, what the conversation was pinned to, and a policy, and
 * returns what to load and what to say about it. The database and the room are
 * somebody else's problem.
 */

/** How a room treats an instruction that has changed since it was pinned. */
export type DriftPolicy =
  /** Load the pinned copy and report the drift. The conversation keeps the rules it started with. */
  | "hold"
  /** Load the live copy and report that it did. */
  | "live"
  /** Do not pin at all: resolve live every turn, which is what happens without this feature. */
  | "off";

export const DRIFT_POLICIES: readonly DriftPolicy[] = ["hold", "live", "off"];

export interface Instruction {
  key: string;
  /** Which scope the body was resolved from, for the packet header. */
  scope: string;
  body: string;
  sha256: string;
}

export interface PacketPlan {
  /** The bodies to load, in the room's declared order. */
  use: Instruction[];
  /** Required keys with nothing to load: absent live, and with no pin to fall back on. */
  missing: string[];
  /** Keys whose live body no longer matches the pin. */
  drifted: string[];
  /** Keys that were pinned and have since disappeared from the registry entirely. */
  vanished: string[];
  /**
   * A stable identity for this drift state, so a room can report each one once.
   *
   * It includes the live hash, not just the key: editing the same instruction a
   * second time is a different state the reader has not been told about, and a
   * signature built from key names alone would swallow it.
   */
  signature: string;
}

/** Hex sha256 of an instruction body. The pin is over content, never over a timestamp. */
export function hashBody(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body, "utf8").digest("hex");
}

/**
 * Decides what a turn actually loads.
 *
 * `keys` is the room's declared order. `live` is what the registry resolves
 * right now; `pins` is what this conversation was minted with. A key absent from
 * `pins` has never been pinned - a key added to the room after minting - and is
 * loaded live rather than treated as drift, because there is no earlier version
 * to have drifted from.
 */
export function planPacket(args: {
  keys: readonly string[];
  live: ReadonlyMap<string, Instruction>;
  pins: ReadonlyMap<string, Instruction>;
  isRequired: (key: string) => boolean;
  policy: DriftPolicy;
}): PacketPlan {
  const { keys, live, pins, isRequired, policy } = args;
  const use: Instruction[] = [];
  const missing: string[] = [];
  const drifted: string[] = [];
  const vanished: string[] = [];
  const marks: string[] = [];

  for (const key of keys) {
    const now = live.get(key);
    const pinned = policy === "off" ? undefined : pins.get(key);

    if (!now && !pinned) {
      if (isRequired(key)) missing.push(key);
      continue;
    }

    if (!now && pinned) {
      // Deleted from the registry while a conversation was running. Under hold
      // the pin is what the conversation has been working to, so it keeps it;
      // under live there is nothing left to load.
      vanished.push(key);
      marks.push(key + "@gone");
      if (policy === "hold") use.push(pinned);
      else if (isRequired(key)) missing.push(key);
      continue;
    }

    if (now && pinned && now.sha256 !== pinned.sha256) {
      drifted.push(key);
      marks.push(key + "@" + now.sha256);
      use.push(policy === "live" ? now : pinned);
      continue;
    }

    use.push(now ?? pinned!);
  }

  return { use, missing, drifted, vanished, signature: marks.sort().join(",") };
}

/** Renders the packet body. Empty when there is nothing to load. */
export function renderPacket(use: readonly Instruction[]): string {
  if (use.length === 0) return "";
  const bodies = use.map((i) => `## ${i.key} (${i.scope})\n${i.body}`);
  return ["<instructions>", ...bodies, "</instructions>"].join("\n\n");
}

/**
 * The notice a room posts when its registry has moved.
 *
 * Written as a statement of what happened and what to type, never as a
 * suggestion that the reader is at fault: drift is the normal consequence of
 * editing an instruction, not a mistake.
 */
export function driftNotice(
  plan: PacketPlan,
  policy: DriftPolicy,
  mention: string,
): string | null {
  if (plan.drifted.length === 0 && plan.vanished.length === 0) return null;
  const lines: string[] = [];

  if (plan.drifted.length > 0) {
    const which = plan.drifted.join(", ");
    lines.push(
      policy === "live"
        ? `**Instructions changed since this conversation started:** ${which}. I am using the new versions, because this room's drift policy is \`live\`.`
        : `**Instructions changed since this conversation started:** ${which}. I am still using the versions I was given, so this conversation has not shifted underneath itself.`,
    );
  }

  if (plan.vanished.length > 0) {
    const which = plan.vanished.join(", ");
    lines.push(
      policy === "hold"
        ? `**Removed from the registry since this conversation started:** ${which}. I am still using the copies I was given.`
        : `**Removed from the registry since this conversation started:** ${which}.`,
    );
  }

  if (policy !== "live") {
    lines.push(`To adopt the current versions, run \`${mention} accept instructions\`.`);
  }
  return lines.join("\n");
}

