import type { FileSink, Subprocess } from "bun";
import { log } from "../log.ts";

export type RuntimeEvent =
  | { kind: "ready"; sessionId: string | null }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-use"; name: string }
  | { kind: "result"; ok: boolean; text: string | null; sessionId: string | null; errorSubtype?: string }
  | { kind: "stderr"; text: string }
  | { kind: "exit"; code: number | null; expected: boolean }
  | { kind: "parse-error"; line: string };

export interface TurnOutcome {
  ok: boolean;
  text: string | null;
  /** complete | interrupted | exited | not-running | a runtime error subtype */
  reason: string;
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

    if (type === "assistant") {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          this.emit({ kind: "assistant-text", text: block.text });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          this.emit({ kind: "tool-use", name: block.name });
        }
      }
      return;
    }

    if (type === "result") {
      this.busy = false;
      const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
      const isError = event.is_error === true || subtype !== "success";
      this.emit({
        kind: "result",
        ok: !isError,
        text: typeof event.result === "string" ? event.result : null,
        sessionId,
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
          } else if (event.kind === "result") {
            settle({
              ok: event.ok,
              text: event.text ?? (collected.length ? collected.join("\n\n") : null),
              reason: event.ok ? "complete" : (event.errorSubtype ?? "error"),
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
  async interrupt(): Promise<void> {
    if (!this.isRunning) return;
    log.info("interrupting coding runtime", { sessionId: this.opts.sessionId });
    await this.stop();
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
