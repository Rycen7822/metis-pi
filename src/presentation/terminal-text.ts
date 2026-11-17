export interface Foreground { fg(role: string, text: string): string }

export function shellTitle(ctx: { isPartial?: boolean; isError?: boolean; isBackground?: boolean }, theme: Foreground) {
  const done = ctx.isPartial === false;
  const bullet = theme.fg(ctx.isError ? "error" : done && !ctx.isBackground ? "success" : "dim", "•");
  return { bullet, title: done ? "Ran" : "Running" };
}

/** Strip untrusted terminal controls before adding presentation-owned ANSI. */
export function safeText(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

export const OUTPUT_INITIAL_PREFIX = "  └ ";
export const OUTPUT_SUBSEQUENT_PREFIX = "    ";

/** Shared result gutter: first output row owns the branch; later rows align under its body. */
export function toolOutputGutter(lines: readonly string[], theme: Foreground, color = "toolOutput"): string {
  return lines.map((line, i) => `${theme.fg("dim", i === 0 ? OUTPUT_INITIAL_PREFIX : OUTPUT_SUBSEQUENT_PREFIX)}${theme.fg(color, line)}`).join("\n");
}
