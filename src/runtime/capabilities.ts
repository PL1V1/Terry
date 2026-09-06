import { log } from "../log.ts";

export interface Capabilities {
  /**
   * Effort levels the installed runtime documents. Null means the runtime does
   * not advertise them — callers must say so rather than offer a guess.
   */
  effortLevels: string[] | null;
  /**
   * Model aliases the installed runtime documents. Null means undiscoverable.
   * This is never the complete catalogue: the runtime has no list command, so
   * full model names are accepted but cannot be enumerated.
   */
  modelAliases: string[] | null;
  /** Permission modes the runtime accepts. Null means undiscoverable. */
  permissionModes: string[] | null;
  /** Permission prompt targets the runtime accepts. */
  permissionPromptTargets: string[] | null;
  /** Flags the runtime accepts, used to fail fast on a version mismatch. */
  flags: Set<string>;
  version: string | null;
}

/**
 * Splits `--help` output into one block per option. Help text wraps
 * continuation lines at a deeper indent, so a block runs until the next line
 * that starts a new flag.
 */
export function splitOptionBlocks(help: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = help.split(/\r?\n/);
  let currentFlags: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentFlags.length === 0) return;
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    for (const flag of currentFlags) blocks.set(flag, text);
  };

  for (const line of lines) {
    const start = /^\s{2}(-[A-Za-z], )?(--[a-z0-9-]+(?:, --[a-z0-9-]+)*)/.exec(line);
    if (start) {
      flush();
      currentFlags = start[2]!.split(", ").map((f) => f.trim());
      buffer = [line.trim()];
    } else if (currentFlags.length > 0 && /^\s{4,}\S/.test(line)) {
      buffer.push(line.trim());
    } else if (line.trim() === "") {
      // Blank lines separate sections but not wrapped descriptions.
    } else if (currentFlags.length > 0 && /^\s{0,3}\S/.test(line)) {
      flush();
      currentFlags = [];
      buffer = [];
    }
  }
  flush();
  return blocks;
}

/** Pulls a parenthesised comma list, e.g. "(low, medium, high, xhigh, max)". */
export function parseParenList(text: string): string[] | null {
  for (const match of text.matchAll(/\(([^()]+)\)/g)) {
    const inner = match[1]!;
    if (inner.includes("e.g.") || !inner.includes(",")) continue;
    const items = inner.split(",").map((s) => s.trim());
    if (items.length >= 2 && items.every((i) => /^[a-z][a-z0-9-]*$/.test(i))) return items;
  }
  return null;
}

/** Pulls single-quoted example values out of a description. */
export function parseQuotedExamples(text: string): string[] | null {
  const found = [...text.matchAll(/'([A-Za-z][A-Za-z0-9.-]*)'/g)].map((m) => m[1]!);
  const unique = [...new Set(found)];
  return unique.length > 0 ? unique : null;
}

/** Pulls a `(choices: "a", "b", "c")` list out of a description. */
export function parseChoices(text: string): string[] | null {
  const match = /(choices:s*([^)]+))/.exec(text);
  if (!match) return null;
  const items = [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  return items.length > 0 ? items : null;
}

export async function runHelp(bin: string): Promise<string> {
  const proc = Bun.spawn([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  // The CLI prints help to stdout but exits non-zero on some builds; take both.
  return `${stdout}\n${stderr}`;
}

async function runVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out || null;
  } catch {
    return null;
  }
}

export function parseCapabilities(help: string, version: string | null = null): Capabilities {
  const blocks = splitOptionBlocks(help);
  const effortBlock = blocks.get("--effort");
  const modelBlock = blocks.get("--model");
  const permissionBlock = blocks.get("--permission-mode");
  const promptsBlock = blocks.get("--permission-prompts");
  return {
    effortLevels: effortBlock ? parseChoices(effortBlock) ?? parseParenList(effortBlock) : null,
    modelAliases: modelBlock ? parseQuotedExamples(modelBlock) : null,
    permissionModes: permissionBlock ? parseChoices(permissionBlock) : null,
    permissionPromptTargets: promptsBlock ? parseChoices(promptsBlock) : null,
    flags: new Set(blocks.keys()),
    version,
  };
}

/**
 * Interrogates the installed coding runtime. Everything reported to a user comes
 * from here; nothing about models or effort is hard-coded in this service.
 */
export async function discoverCapabilities(bin: string): Promise<Capabilities> {
  const [help, version] = await Promise.all([runHelp(bin), runVersion(bin)]);
  const caps = parseCapabilities(help, version);
  log.info("runtime capabilities discovered", {
    version: caps.version,
    effortLevels: caps.effortLevels,
    modelAliases: caps.modelAliases,
    flagCount: caps.flags.size,
  });
  const missing = ["--print", "--output-format", "--input-format", "--session-id", "--resume"].filter(
    (f) => !caps.flags.has(f),
  );
  if (missing.length > 0) {
    throw new Error(
      `Installed coding runtime does not support required flags: ${missing.join(", ")}. ` +
        "The adapter needs a headless streaming interface.",
    );
  }
  return caps;
}

/**
 * Rejects a permission mode the installed runtime does not accept, rather than
 * letting the process fail at spawn time with an opaque error.
 */
export function assertPermissionSettings(
  caps: Capabilities,
  mode: string,
  prompts: string,
): void {
  if (caps.permissionModes && !caps.permissionModes.includes(mode)) {
    throw new Error(
      `PERMISSION_MODE '${mode}' is not supported by the installed runtime. ` +
        `Supported: ${caps.permissionModes.join(", ")}`,
    );
  }
  if (caps.permissionPromptTargets && !caps.permissionPromptTargets.includes(prompts)) {
    throw new Error(
      `PERMISSION_PROMPTS '${prompts}' is not supported by the installed runtime. ` +
        `Supported: ${caps.permissionPromptTargets.join(", ")}`,
    );
  }
}
