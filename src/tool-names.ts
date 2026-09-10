// Shared types and small helpers used across renderer modules.
// Every transformation here affects a DISPLAY string/component only.

export const TOOL_NAMES = ["bash", "powershell", "read", "grep", "find", "ls", "edit", "write"] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type RecordValue = Readonly<Record<string, unknown>>;

export interface Palette { fg(color: string, text: string): string; bold(text: string): string }
export interface ViewContext {
  readonly args?: unknown;
  readonly toolCallId?: string;
  readonly cwd?: string;
  readonly state?: unknown;
  readonly isPartial?: boolean;
  readonly isError?: boolean;
  readonly executionStarted?: boolean;
  readonly expanded?: boolean;
  readonly showImages?: boolean;
  readonly lastComponent?: unknown;
}
export interface ViewOptions { readonly expanded?: boolean; readonly isPartial?: boolean }
export interface Component { render(width: number): string[] }
export interface TextComponent extends Component { setText(text: string): void }
export type TextFactory = (text: string) => TextComponent;
export type Highlight = (text: string, language: string) => string;
export interface Renderers {
  renderCall(args: unknown, theme: Palette, context: ViewContext): Component;
  renderResult(result: unknown, options: ViewOptions, theme: Palette, context: ViewContext): Component;
}
export interface DiffComponentInput {
  readonly diff: string;
  readonly filePath: string;
  readonly theme: Palette;
  readonly context: ViewContext;
  readonly options: ViewOptions;
}
export type DiffFactory = (input: DiffComponentInput) => Component;
export interface DiffLayoutOps {
  wrap(text: string, width: number): string[];
  visibleWidth(text: string): number;
}

export function asRecord(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export function safeText(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
