import { log } from "../log.ts";

const API = "https://discord.com/api/v10";

/** Discord's hard limit on message content. */
export const MAX_MESSAGE = 2000;

/**
 * Splits text into Discord-sized pieces, preferring paragraph then line then
 * word boundaries, and never splitting a fenced code block across a chunk
 * without reopening the fence.
 */
export function chunk(text: string, limit: number = MAX_MESSAGE): string[] {
  if (text.length <= limit) return text.length ? [text] : [];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = -1;
    for (const separator of ["\n\n", "\n", " "]) {
      cut = remaining.lastIndexOf(separator, limit);
      if (cut > limit * 0.5) break;
      cut = -1;
    }
    if (cut === -1) cut = limit;

    let piece = remaining.slice(0, cut);
    remaining = remaining.slice(cut).replace(/^\s+/, "");

    // Re-balance code fences so a split block still renders on both sides.
    const fences = (piece.match(/```/g) ?? []).length;
    if (fences % 2 === 1) {
      piece += "\n```";
      remaining = `\`\`\`\n${remaining}`;
    }
    chunks.push(piece);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

export interface SentMessage {
  id: string;
  channel_id: string;
}

/**
 * The message operations the controller depends on.
 *
 * Declared as an interface so a room can be driven by something other than the
 * live Discord API — the acceptance harness supplies its own implementation and
 * exercises the real controller.
 */
export interface MessageTransport {
  sendMessage(
    channelId: string,
    text: string,
    options?: { replyTo?: string; allowMentions?: boolean },
  ): Promise<SentMessage[]>;
  recentMessages(channelId: string, limit: number): Promise<unknown[]>;
  /**
   * Optional: a transport without it gets post-at-end replies instead of a
   * reply that grows in place. Absent on a stand-in that has no messages to edit.
   */
  editMessage?(channelId: string, messageId: string, text: string): Promise<void>;
  /** Optional: needed to take back a placeholder for a turn that turned out not to be for us. */
  deleteMessage?(channelId: string, messageId: string): Promise<void>;
}

export class Rest implements MessageTransport {
  constructor(private readonly token: string) {}

  private async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 429) {
      const retry = (await response.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.ceil((retry.retry_after ?? 1) * 1000);
      if (attempt >= 5) throw new Error(`Rate limited by Discord and out of retries on ${method} ${path}`);
      log.warn("rate limited by discord", { path, waitMs, attempt });
      await Bun.sleep(waitMs);
      return this.request<T>(method, path, body, attempt + 1);
    }

    if (response.status >= 500 && attempt < 5) {
      const waitMs = Math.min(8_000, 500 * 2 ** attempt);
      log.warn("discord server error; retrying", { path, status: response.status, waitMs });
      await Bun.sleep(waitMs);
      return this.request<T>(method, path, body, attempt + 1);
    }

    if (!response.ok) {
      // The status and path are enough to diagnose; the body may quote the token.
      throw new Error(`Discord API ${method} ${path} failed with HTTP ${response.status}`);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /**
   * Posts text as one or more messages, in order. Mentions are disabled by
   * default so relayed output can never ping a channel by accident.
   */
  async sendMessage(
    channelId: string,
    text: string,
    options: { replyTo?: string; allowMentions?: boolean } = {},
  ): Promise<SentMessage[]> {
    const pieces = chunk(text);
    const sent: SentMessage[] = [];
    for (const [index, piece] of pieces.entries()) {
      const body: Record<string, unknown> = {
        content: piece,
        allowed_mentions: options.allowMentions ? undefined : { parse: [] },
      };
      // Only the first piece quotes the message being replied to.
      if (index === 0 && options.replyTo) {
        body.message_reference = { message_id: options.replyTo, fail_if_not_exists: false };
      }
      sent.push(await this.request<SentMessage>("POST", `/channels/${channelId}/messages`, body));
    }
    return sent;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, {
      content: text.slice(0, MAX_MESSAGE),
      allowed_mentions: { parse: [] },
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const encoded = encodeURIComponent(emoji);
    await this.request(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
    );
  }

  /** Guilds this bot is a member of. */
  async botGuilds(): Promise<Array<{ id: string; name: string }>> {
    return this.request("GET", "/users/@me/guilds");
  }

  /** Roles in a guild, including the managed roles Discord creates for bots. */
  async guildRoles(
    guildId: string,
  ): Promise<Array<{ id: string; name: string; tags?: { bot_id?: string } }>> {
    return this.request("GET", `/guilds/${guildId}/roles`);
  }

  /** Most recent messages first, as Discord returns them. */
  async recentMessages(channelId: string, limit: number): Promise<unknown[]> {
    return this.request<unknown[]>("GET", `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`);
  }
}
