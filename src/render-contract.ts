import type { ToolName } from "./tool-names.ts";

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
  /** Host callback that rebuilds and redraws this tool row. */
  readonly invalidate?: () => void;
  /** Persisted final tool duration; available after execution ends. */
  readonly durationMs?: number;
  readonly isError?: boolean;
  /** Host lifecycle: a final result exists (call slot may collapse). */
  readonly hasResult?: boolean;
  readonly expanded?: boolean;
  readonly showImages?: boolean;
  /** Injected write change (tests/preview) — merged with tracker state. */
  readonly writeChanges?: unknown;
  readonly lastComponent?: unknown;
  /** Nested display data stays owned by the bounded store, not evicted UI bodies. */
  readonly resultSource?: () => { args: unknown; result: unknown } | undefined;
  /** Real color capability, injected by the host (pi-tui getCapabilities). */
  readonly colorLevel?: import("./palette.ts").ColorLevel;
  /** Transcript presentation plan for exploration grouping (host-injected). */
  readonly explorationPlan?: unknown;
}
export interface ViewOptions { readonly expanded?: boolean; readonly isPartial?: boolean }
export interface Component {
  render(width: number): string[];
  invalidate(): void;
  handleMouse?: import("@earendil-works/pi-tui").Component["handleMouse"];
}
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
