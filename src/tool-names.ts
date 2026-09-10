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
  /** Host lifecycle: args streaming finished (toolCall args complete). */
  readonly argsComplete?: boolean;
  /** Host lifecycle: tool execution started (markExecutionStarted). */
  readonly executionStarted?: boolean;
  readonly isError?: boolean;
  /** Host lifecycle: a final result exists (call slot may collapse). */
  readonly hasResult?: boolean;
  readonly expanded?: boolean;
  readonly showImages?: boolean;
  /** Injected write change (tests/preview) — merged with tracker state. */
  readonly writeChanges?: unknown;
  readonly lastComponent?: unknown;
  /** Real color capability, injected by the host (pi-tui getCapabilities). */
  readonly colorLevel?: import("./palette.ts").ColorLevel;
  /** Transcript presentation plan for exploration grouping (host-injected). */
  readonly explorationPlan?: unknown;
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
  readonly rows: readonly import("./diff.ts").DiffRow[];
  readonly filePath: string;
  readonly theme: Palette;
  readonly context: ViewContext;
  readonly options: ViewOptions;
  /** Pi-bound expand hint for row-budget notices inside the diff body. */
  readonly expandHint?: string;
}
export type DiffFactory = (input: DiffComponentInput) => Component;
export interface DiffLayoutOps {
  wrap(text: string, width: number): string[];
  visibleWidth(text: string): number;
}

/** Shell model shared by the call-slot and result-slot components. */
export interface ShellComponentInput {
  readonly name: ToolName;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
  readonly options: ViewOptions;
  readonly theme: Palette;
  readonly context: ViewContext;
  readonly expandHint: string;
  readonly colorLevel: import("./palette.ts").ColorLevel;
}
/** Call region: title + command. Never output. */
export type ShellCallFactory = (input: ShellComponentInput) => Component;
/** Result region: output block. Never a command head. */
export type ShellResultFactory = (input: ShellComponentInput) => Component;

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
