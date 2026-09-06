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
 *   __SLOW__  waits long enough to be interrupted
 *   __FAIL__  reports an error result
 *   __CRASH__ exits without producing a result
 */
function arg(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index !== -1 ? (Bun.argv[index + 1] ?? null) : null;
}

const sessionId = arg("--session-id") ?? arg("--resume") ?? "fake-session";
const model = arg("--model");
const effort = arg("--effort");
const resumed = Bun.argv.includes("--resume");

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

    if (text.includes("__SLOW__")) {
      // Long enough that a test can interrupt it, short enough not to hang CI.
      await Bun.sleep(30_000);
    }

    if (text.includes("__FAIL__")) {
      emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
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
