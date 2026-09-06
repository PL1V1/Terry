import type { FileSink, Subprocess } from "bun";
import { log } from "../log.ts";

export type RuntimeEvent =
  | { kind: "ready"; sessionId: string | null }
  | { kind: "assistant-text"; text: string }
  /** A fragment of assistant text, as it is generated. Only with partial messages on. */
  | { kind: "text-delta"; text: string }
  | { kind: "tool-use"; name: string; input: Record<string, unknown> }
  | { kind: "result"; ok: boolean; text: string | null; sessionId: string | null; errorSubtype?: string; usage?: TurnUsage }
  | { kind: "stderr"; text: string }
  | { kind: "exit"; code: number | null; expected: boolean }
  | { kind: "parse-error"; line: string };

/** What a turn cost, as the runtime reports it. Nulls mean it did not say. */
export interface TurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface TurnOutcome {
  ok: boolean;
  text: string | null;
  /** complete | interrupted | exited | not-running | a runtime error subtype */
  reason: string;
  usage?: TurnUsage;
}

/** The runtime's answer to a control request. */
export interface ControlResult {
  ok: boolean;
  /** "timeout", "not-running", or the runtime's own message. */
  error?: string;
  response?: unknown;
}

export interface SessionOptions {
  bin: string;
  cwd: string;
  /** Conversation id we own, so the mapping survives a restart. */
  sessionId: string;
  /** Resume an existing conversation rather than starting a new one. */
  resume: boolean;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  /** Who answers permission prompts. "none" fails closed. */
  permissionPrompts: string;
  /** Ask for text as it is generated, so a reply can be shown growing. */
  partial: boolean;
  /**
   * How long to wait for an in-band interrupt to take effect before the process
   * is terminated instead. The kill is the fallback, not the method.
   */
  interruptGraceMs: number;
  onEvent: (event: RuntimeEvent) => void;
}

/**
 * Wraps one coding-runtime conversation as a long-lived streaming process.
 *
 * Input and output are both newline-delimited JSON, so the process stays alive
 * between turns and the conversation keeps its context. The service owns the
 * session id; the runtime owns the conversation content.
 */
export class ClaudeSession {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private stdin: FileSink | null = null;
  private stopping = false;
  private busy = false;
  /** Type of the content block currently streaming, so only text deltas are relayed. */
  private blockType: string | null = null;
  /** Text blocks seen this turn, so a second one is separated from the first. */
  private textBlocks = 0;
  /** Answers awaited from control requests, by request id. */
  private readonly pending = new Map<string, (r: ControlResult) => void>();
  private controlSeq = 0;
  /** Set while an interrupt is in flight, so the turn it lands on reports as interrupted. */
  private interrupting = false;

  private handler: (event: RuntimeEvent) => void;

  constructor(private readonly opts: SessionOptions) {
    this.handler = opts.onEvent;
  }

  private emit(event: RuntimeEvent): void {
    this.handler(event);
  }

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  buildArgs(): string[] {
    const o = this.opts;
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      o.permissionMode,
      "--permission-prompts",
      o.permissionPrompts,
    ];
    if (o.partial) args.push("--include-partial-messages");
    // Resuming and assigning an id are mutually exclusive: one continues a
    // conversation, the other names a new one.
    if (o.resume) args.push("--resume", o.sessionId);
    else args.push("--session-id", o.sessionId);
    if (o.model) args.push("--model", o.model);
    if (o.effort) args.push("--effort", o.effort);
    return args;
  }

  start(): void {
    if (this.isRunning) return;
    this.stopping = false;
    const args = this.buildArgs();
    log.info("starting coding runtime", { sessionId: this.opts.sessionId, resume: this.opts.resume, args });

    this.proc = Bun.spawn([this.opts.bin, ...args], {
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env },
    }) as Subprocess<"pipe", "pipe", "pipe">;

    this.stdin = this.proc.stdin;
    void this.pumpStdout();
    void this.pumpStderr();
    void this.watchExit();
  }

  private async pumpStdout(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.handleLine(line);
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const text = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const trimmed = text.trim();
    if (trimmed) this.emit({ kind: "stderr", text: trimmed });
  }

  private async watchExit(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const code = await proc.exited;
    this.busy = false;
    this.emit({ kind: "exit", code, expected: this.stopping });
  }

  private handleLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit({ kind: "parse-error", line });
      return;
    }

    const type = event.type;
    const sessionId = typeof event.session_id === "string" ? event.session_id : null;

    if (type === "system" && event.subtype === "init") {
      this.emit({ kind: "ready", sessionId });
      return;
    }

    if (type === "control_response") {
      const r = event.response as { request_id?: string; subtype?: string; error?: string; response?: unknown } | undefined;
      const resolve = r?.request_id ? this.pending.get(r.request_id) : undefined;
      if (resolve) {
        resolve(r?.subtype === "success" ? { ok: true, response: r.response } : { ok: false, error: r?.error ?? "error" });
      }
      return;
    }

    if (type === "stream_event") {
      // The runtime wraps the API stream; only text deltas are of interest here.
      // Thinking and tool-input deltas are ignored, and the complete assistant
      // message still follows, so nothing is lost by dropping them.
      const inner = event.event as Record<string, unknown> | undefined;
      if (inner?.type === "content_block_start") {
        const block = inner.content_block as { type?: string } | undefined;
        this.blockType = typeof block?.type === "string" ? block.type : null;
        if (this.blockType === "text") {
          if (this.textBlocks > 0) this.emit({ kind: "text-delta", text: "\n\n" });
          this.textBlocks += 1;
        }
      } else if (inner?.type === "content_block_delta" && this.blockType === "text") {
        const delta = inner.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          this.emit({ kind: "text-delta", text: delta.text });
        }
      } else if (inner?.type === "content_block_stop") {
        this.blockType = null;
      }
      return;
    }

    if (type === "assistant") {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          this.emit({ kind: "assistant-text", text: block.text });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
          this.emit({ kind: "tool-use", name: block.name, input });
        }
      }
      return;
    }

    if (type === "result") {
      this.busy = false;
      const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
      const isError = event.is_error === true || subtype !== "success";
      const u = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const usage: TurnUsage = {
        inputTokens: num(u?.input_tokens),
        outputTokens: num(u?.output_tokens),
        costUsd: num(event.total_cost_usd),
        durationMs: num(event.duration_ms) ?? num(event.duration_api_ms),
      };
      this.textBlocks = 0;
      this.blockType = null;
      this.emit({
        kind: "result",
        ok: !isError,
        text: typeof event.result === "string" ? event.result : null,
        sessionId,
        usage,
        ...(isError ? { errorSubtype: subtype } : {}),
      });
    }
  }

  /**
   * Runs one turn to completion.
   *
   * Installs a temporary handler for the duration, so the caller gets this
   * turn's output without having to reach into the session's internals, and
   * restores the base handler afterwards whatever happens.
   */
  async runTurn(text: string): Promise<TurnOutcome> {
    if (!this.isRunning) return { ok: false, text: null, reason: "not-running" };
    const base = this.handler;
    const collected: string[] = [];

    try {
      return await new Promise<TurnOutcome>((resolve) => {
        let settled = false;
        const settle = (outcome: TurnOutcome): void => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };

        this.handler = (event) => {
          base(event);
          if (event.kind === "assistant-text") {
            collected.push(event.text);
          } else if (event.kind === "result" && this.interrupting) {
            // Stop means stop: whatever the runtime produced before it honoured
            // the interrupt is discarded, the same as when it had to be killed.
            this.interrupting = false;
            settle({ ok: false, text: null, reason: "interrupted" });
          } else if (event.kind === "result") {
            settle({
              ok: event.ok,
              text: event.text ?? (collected.length ? collected.join("\n\n") : null),
              reason: event.ok ? "complete" : (event.errorSubtype ?? "error"),
              ...(event.usage ? { usage: event.usage } : {}),
            });
          } else if (event.kind === "exit") {
            settle({
              ok: false,
              text: collected.length ? collected.join("\n\n") : null,
              reason: event.expected ? "interrupted" : "exited",
            });
          }
        };

        void this.send(text).then((sent) => {
          if (!sent) settle({ ok: false, text: null, reason: "not-running" });
        });
      });
    } finally {
      this.handler = base;
    }
  }

  /** Submits a turn. Returns false if the process is not running. */
  async send(text: string): Promise<boolean> {
    if (!this.isRunning || !this.stdin) return false;
    const payload = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    };
    this.busy = true;
    this.stdin.write(`${JSON.stringify(payload)}\n`);
    await this.stdin.flush();
    return true;
  }

  /**
   * Interrupts the current turn. The runtime has no in-band interrupt on the
   * stream-json input channel, so this terminates the process; the conversation
   * itself is untouched and the next turn resumes it by id.
   */
  /**
   * Interrupts the current turn.
   *
   * The stream-json channel accepts an in-band interrupt, so the turn is asked
   * to stop and the process stays warm for the next one. A runtime that does not
   * honour it within the grace period is terminated instead; the conversation
   * is untouched either way and the next turn resumes it by id.
   */
  async interrupt(): Promise<void> {
    if (!this.isRunning) return;
    if (!this.busy) return;
    this.interrupting = true;
    log.info("interrupting coding runtime", { sessionId: this.opts.sessionId });

    const asked = await this.control("interrupt", {}, 2_000);
    if (asked.ok) {
      const deadline = Date.now() + this.opts.interruptGraceMs;
      while (this.busy && Date.now() < deadline) await Bun.sleep(25);
      if (!this.busy) {
        log.info("runtime interrupted in-process", { sessionId: this.opts.sessionId });
        return;
      }
    }

    log.warn("interrupt not honoured; terminating runtime", {
      sessionId: this.opts.sessionId,
      reason: asked.ok ? "grace expired" : asked.error,
    });
    this.interrupting = false;
    await this.stop();
  }

  /** Sends a control request and waits for the answer, or a timeout. */
  async control(subtype: string, params: Record<string, unknown> = {}, timeoutMs = 3_000): Promise<ControlResult> {
    if (!this.isRunning || !this.stdin) return { ok: false, error: "not-running" };
    this.controlSeq += 1;
    const id = `c${this.controlSeq}`;
    const answer = new Promise<ControlResult>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype, ...params } }) + "\n");
    await this.stdin.flush();
    const timeout = Bun.sleep(timeoutMs).then((): ControlResult => ({ ok: false, error: "timeout" }));
    const result = await Promise.race([answer, timeout]);
    this.pending.delete(id);
    return result;
  }

  /**
   * Applies new settings to the running process where the protocol allows it.
   *
   * Model and permission mode switch in-process. Effort does not - the installed
   * runtime reports set_effort unsupported - so an effort change returns false
   * and the caller restarts, exactly as every change used to. False always
   * means "restart", never "ignored".
   */
  async applySettings(next: { model: string | null; effort: string | null; permissionMode: string }): Promise<boolean> {
    const o = this.opts;
    if (next.effort !== o.effort) return false;
    if (next.model !== o.model) {
      // Reverting to the runtime's default is not expressible as a switch.
      if (!next.model) return false;
      const r = await this.control("set_model", { model: next.model });
      if (!r.ok) {
        log.warn("in-process model switch refused; restarting instead", { model: next.model, error: r.error });
        return false;
      }
      o.model = next.model;
    }
    if (next.permissionMode !== o.permissionMode) {
      const r = await this.control("set_permission_mode", { mode: next.permissionMode });
      if (!r.ok) {
        log.warn("in-process permission switch refused; restarting instead", { mode: next.permissionMode, error: r.error });
        return false;
      }
      o.permissionMode = next.permissionMode;
    }
    return true;
  }


  async stop(): Promise<void> {
    this.stopping = true;
    this.busy = false;
    const proc = this.proc;
    if (!proc) return;
    try {
      this.stdin?.end();
    } catch {
      // stdin may already be closed by an exiting child.
    }
    this.stdin = null;
    proc.kill();
    await proc.exited;
    this.proc = null;
  }
}
