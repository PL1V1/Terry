/**
 * A stand-in for the coding runtime.
 *
 * Speaks the same newline-delimited JSON protocol as the real CLI over the same
 * flags, so the adapter and the room controller can be exercised end to end
 * without spending real model calls. It is deliberately dumb: it echoes, and it
 * reports back the settings it was launched with so tests can assert that a
 * model or effort change actually reached the process.
 *
 * Special prompts:
 *   __SLOW__     waits long enough to be interrupted
 *   __PARTIAL__  emits assistant text and then hangs, so a test can interrupt a
 *                turn that has already produced output
 *   __FAIL__  reports an error result
 *   __CRASH__ exits without producing a result
 *   __ECHOPROMPT__ echoes the entire prompt, so a test can see what was sent
 *   __DECLINE__ replies with exactly the ambient not-for-me sentinel
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index !== -1 ? (Bun.argv[index + 1] ?? null) : null;
}

const sessionId = arg("--session-id") ?? arg("--resume") ?? "fake-session";
const model = arg("--model");
const effort = arg("--effort");
const resumed = Bun.argv.includes("--resume");

/**
 * The real CLI distinguishes creating a conversation from continuing one, and
 * rejects the wrong verb: --session-id for an id it already knows fails with
 * "Session ID is already in use", and --resume for one it does not know fails
 * too. A stub that accepted either would let a restart bug through, so this one
 * keeps a marker per session id and enforces the same rule.
 */
const stateDir = `${Bun.env.FAKE_RUNTIME_STATE ?? Bun.env.TEMP ?? "/tmp"}/terry-fake-runtime`;
mkdirSync(stateDir, { recursive: true });
const marker = join(stateDir, sessionId);

if (resumed && !existsSync(marker)) {
  process.stderr.write(`Error: No conversation found with session ID ${sessionId}.
`);
  process.exit(1);
}
if (!resumed && existsSync(marker)) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.
`);
  process.exit(1);
}
writeFileSync(marker, "");

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

emit({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model,
  effort,
  resumed,
});

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk as Uint8Array, { stream: true });
  let index: number;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;

    let text = "";
    try {
      const parsed = JSON.parse(line) as {
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      text = parsed.message?.content?.find((b) => b.type === "text")?.text ?? "";
    } catch {
      emit({ type: "result", subtype: "parse_error", is_error: true, session_id: sessionId });
      continue;
    }

    if (text.includes("__CRASH__")) process.exit(3);

    if (text.includes("__PARTIAL__")) {
      emit({
        type: "assistant",
        session_id: sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "partial output before interrupt" }] },
      });
      await Bun.sleep(30_000);
    }

    if (text.includes("__SLOW__")) {
      // Long enough that a test can interrupt it, short enough not to hang CI.
      await Bun.sleep(30_000);
    }

    if (text.includes("__FAIL__")) {
      emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
      continue;
    }


    // Echoes the WHOLE prompt, not just the operator line, so a test can assert
    // which instruction bodies actually reached the runtime. The ordinary reply
    // deliberately shows only the last line; pinning is about the rest.
    if (text.includes("__ECHOPROMPT__")) {
      emit({
        type: "assistant",
        session_id: sessionId,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId });
      continue;
    }


    // Emits exactly the not-for-me sentinel, so a test can exercise the runtime
    // declining an ambient message. The ordinary echo would wrap it in "echo:"
    // and the decline would not be recognised, which is the bug worth catching.
    if (text.includes("__DECLINE__")) {
      emit({
        type: "assistant",
        session_id: sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "__NOT_FOR_ME__" }] },
      });
      emit({ type: "result", subtype: "success", is_error: false, result: "__NOT_FOR_ME__", session_id: sessionId });
      continue;
    }

    const reply = [
      `echo: ${text.split("\n").at(-1)}`,
      `model=${model ?? "none"}`,
      `effort=${effort ?? "none"}`,
      `resumed=${resumed}`,
      // Lets a test tell one runtime process from another.
      `pid=${process.pid}`,
    ].join(" | ");

    emit({
      type: "assistant",
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
    });
    emit({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId });
  }
}
