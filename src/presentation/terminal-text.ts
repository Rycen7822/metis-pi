export interface Foreground { fg(role: string, text: string): string }

export interface ToolState { isPartial?: boolean; isError?: boolean; isBackground?: boolean }

export function toolBullet(ctx: ToolState | undefined, theme: Foreground): string {
  return theme.fg(ctx?.isError ? "error" : ctx?.isPartial === false && !ctx.isBackground ? "success" : "dim", "•");
}

export function shellTitle(ctx: ToolState, theme: Foreground) {
  return { bullet: toolBullet(ctx, theme), title: ctx.isPartial === false ? "Ran" : "Running" };
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

export const COMMAND_CONTINUATION_PREFIX = "  │ ";
export const OUTPUT_INITIAL_PREFIX = "  └ ";
export const OUTPUT_SUBSEQUENT_PREFIX = "    ";
