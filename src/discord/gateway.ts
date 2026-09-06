import { log } from "../log.ts";

const API = "https://discord.com/api/v10";

/** GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  webhook_id?: string;
  timestamp: string;
  referenced_message?: { id: string; author?: { id: string; username: string } } | null;
  attachments?: Array<{ id: string; filename: string; content_type?: string; size: number; url: string }>;
  mentions?: Array<{ id: string }>;
}

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible";

export interface GatewayHandlers {
  onMessage: (message: DiscordMessage) => void;
  onReady: (data: { session_id: string; resume_gateway_url: string; user: { id: string; username?: string } }) => void;
  onConnectionState: (state: "connecting" | "ready" | "resuming" | "disconnected") => void;
  /**
   * A close code that can never succeed on retry. The gateway stops; what
   * happens to the process is the caller's decision, because silently staying
   * alive and disconnected is the one thing it must not do.
   */
  onFatal?: (code: number) => void;
}

/**
 * Discord Gateway client with heartbeat, RESUME and bounded reconnect backoff.
 *
 * Reconnection follows the protocol rather than blindly redialling: a resumable
 * close replays through the resume URL, a non-resumable one re-identifies, and a
 * fatal one stops instead of hammering Discord with a doomed request.
 */
export class Gateway {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private acked = true;
  private attempt = 0;
  private closed = false;
  private currentPresence: { status: PresenceStatus; activity: string | null } | null = null;

  /** Close codes that can never succeed on retry. */
  static readonly FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

  /** Close codes after which the session cannot be resumed and must re-identify. */
  static readonly NON_RESUMABLE = new Set([4007, 4009, 1000, 1001]);

  constructor(
    private readonly token: string,
    private readonly handlers: GatewayHandlers,
  ) {}

  async connect(): Promise<void> {
    this.closed = false;
    const url = this.resumeUrl ?? `${await this.fetchGatewayUrl()}?v=10&encoding=json`;
    this.dial(url);
  }

  private async fetchGatewayUrl(): Promise<string> {
    const response = await fetch(`${API}/gateway/bot`, {
      headers: { Authorization: `Bot ${this.token}` },
    });
    if (!response.ok) {
      // Deliberately does not echo the response body, which can quote the token.
      throw new Error(`Gateway lookup failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { url: string };
    return body.url;
  }

  private dial(url: string): void {
    this.handlers.onConnectionState(this.sessionId ? "resuming" : "connecting");
    log.info("gateway dialling", { resuming: Boolean(this.sessionId), attempt: this.attempt });

    const ws = new WebSocket(url);
    this.ws = ws;
    this.acked = true;

    ws.addEventListener("message", (event) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(String(event.data)) as GatewayPayload;
      } catch {
        log.warn("gateway sent a frame that is not JSON");
        return;
      }
      this.handlePayload(payload);
    });

    ws.addEventListener("close", (event) => {
      this.stopHeartbeat();
      log.warn("gateway closed", { code: event.code });
      this.handlers.onConnectionState("disconnected");
      if (!this.closed) void this.scheduleReconnect(event.code);
    });

    ws.addEventListener("error", () => {
      log.warn("gateway socket error");
    });
  }

  /** Exponential backoff with jitter, capped so a long outage still retries. */
  backoffFor(attempt: number): number {
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    return base / 2 + Math.random() * (base / 2);
  }

  private async scheduleReconnect(code: number): Promise<void> {
    if (Gateway.FATAL_CLOSE_CODES.has(code)) {
      log.error("gateway closed with a fatal code; not reconnecting", { code });
      this.handlers.onFatal?.(code);
      return;
    }
    if (Gateway.NON_RESUMABLE.has(code)) {
      this.sessionId = null;
      this.resumeUrl = null;
    }
    this.attempt += 1;
    const delay = this.backoffFor(this.attempt);
    log.info("gateway reconnecting", { attempt: this.attempt, delayMs: Math.round(delay) });
    await Bun.sleep(delay);
    if (this.closed) return;
    try {
      await this.connect();
    } catch (error) {
      log.error("gateway reconnect failed", { error });
      void this.scheduleReconnect(1006);
    }
  }

  private handlePayload(payload: GatewayPayload): void {
    if (typeof payload.s === "number") this.sequence = payload.s;

    switch (payload.op) {
      case OP.HELLO: {
        const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(interval);
        if (this.sessionId) {
          this.send({
            op: OP.RESUME,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
          });
        } else {
          this.identify();
        }
        return;
      }
      case OP.HEARTBEAT:
        this.send({ op: OP.HEARTBEAT, d: this.sequence });
        return;
      case OP.HEARTBEAT_ACK:
        this.acked = true;
        return;
      case OP.RECONNECT:
        log.info("gateway asked us to reconnect");
        this.ws?.close(4900, "reconnect requested");
        return;
      case OP.INVALID_SESSION:
        log.warn("gateway session invalidated", { resumable: payload.d === true });
        if (payload.d !== true) {
          this.sessionId = null;
          this.resumeUrl = null;
        }
        this.ws?.close(4901, "invalid session");
        return;
      case OP.DISPATCH:
        this.handleDispatch(payload);
        return;
      default:
        return;
    }
  }

  private handleDispatch(payload: GatewayPayload): void {
    if (payload.t === "READY") {
      const data = payload.d as { session_id: string; resume_gateway_url: string; user: { id: string; username?: string } };
      this.sessionId = data.session_id;
      this.resumeUrl = `${data.resume_gateway_url}?v=10&encoding=json`;
      this.attempt = 0;
      this.handlers.onConnectionState("ready");
      this.reassertPresence();
      this.handlers.onReady(data);
      return;
    }
    if (payload.t === "RESUMED") {
      this.attempt = 0;
      this.handlers.onConnectionState("ready");
      this.reassertPresence();
      return;
    }
    if (payload.t === "MESSAGE_CREATE") {
      this.handlers.onMessage(payload.d as DiscordMessage);
    }
  }

  /** Presence is re-sent after every (re)connect so state survives a drop. */
  private reassertPresence(): void {
    if (this.currentPresence) {
      this.setPresence(this.currentPresence.status, this.currentPresence.activity);
    }
  }

  private identify(): void {
    this.send({
      op: OP.IDENTIFY,
      d: {
        token: this.token,
        intents: INTENTS,
        properties: { os: process.platform, browser: "terry", device: "terry" },
        presence: { status: "idle", activities: [], since: null, afk: false },
      },
    });
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    // The first beat is jittered, as the Gateway documentation requires.
    setTimeout(() => this.beat(), interval * Math.random());
    this.heartbeatTimer = setInterval(() => this.beat(), interval);
  }

  private beat(): void {
    if (!this.acked) {
      // A missed acknowledgement means a zombie connection: drop it and resume.
      log.warn("heartbeat not acknowledged; dropping connection");
      this.ws?.close(4902, "heartbeat timeout");
      return;
    }
    this.acked = false;
    this.send({ op: OP.HEARTBEAT, d: this.sequence });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  setPresence(status: PresenceStatus, activity: string | null): void {
    this.currentPresence = { status, activity };
    this.send({
      op: OP.PRESENCE_UPDATE,
      d: {
        since: null,
        afk: false,
        status,
        activities: activity ? [{ name: activity, type: 4, state: activity }] : [],
      },
    });
  }

  private send(payload: GatewayPayload): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close(1000, "shutting down");
    this.ws = null;
  }
}
