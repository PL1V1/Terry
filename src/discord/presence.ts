import type { Gateway, PresenceStatus } from "./gateway.ts";
import { log } from "../log.ts";

export type ServiceState = "asleep" | "awake" | "working" | "connecting" | "unavailable";

const STATUS_FOR: Record<ServiceState, PresenceStatus> = {
  asleep: "idle",
  awake: "online",
  working: "dnd",
  connecting: "idle",
  unavailable: "invisible",
};

const DEFAULT_ACTIVITY: Record<ServiceState, string> = {
  asleep: "asleep — mention me with wakeup",
  awake: "Talk to me",
  working: "On the job",
  connecting: "connecting",
  unavailable: "unavailable",
};

/**
 * Sole owner of the bot's presence.
 *
 * Discord rate-limits presence updates, and a busy room would otherwise emit one
 * per event. Updates are coalesced onto a trailing timer and identical states are
 * dropped, so the indicator stays truthful without flooding the socket.
 */
export class PresenceController {
  private desired: { state: ServiceState; activity: string | null } | null = null;
  private lastSent: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;

  constructor(
    private readonly gateway: Gateway,
    private readonly minIntervalMs = 5_000,
  ) {}

  /** Requests a presence. The write itself is coalesced and rate-limited. */
  set(state: ServiceState, activityOverride: string | null = null): void {
    this.desired = { state, activity: activityOverride ?? DEFAULT_ACTIVITY[state] };
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    const elapsed = Date.now() - this.lastSentAt;
    const wait = Math.max(0, this.minIntervalMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (!this.desired) return;
    const { state, activity } = this.desired;
    const fingerprint = `${state}|${activity ?? ""}`;
    if (fingerprint === this.lastSent) return;
    this.lastSent = fingerprint;
    this.lastSentAt = Date.now();
    log.debug("presence update", { state, activity });
    this.gateway.setPresence(STATUS_FOR[state], activity);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
