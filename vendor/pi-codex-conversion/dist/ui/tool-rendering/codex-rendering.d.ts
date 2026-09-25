import { type ShellAction } from "../../shell/summary.ts";
import type { ExecCommandStatus } from "../../tools/exec/command-state.ts";
export interface RenderTheme {
    fg(role: string, text: string): string;
    bold(text: string): string;
    /** Optional metis-pi call-only painter; no shared state across extension loaders. */
    highlightCommandLines?(lines: readonly string[]): string[];
}
export declare function renderExecCommandCall(command: string, state: ExecCommandStatus, theme: RenderTheme, expanded?: boolean): string;
export declare function renderGroupedExecCommandCall(actionGroups: ShellAction[][], state: ExecCommandStatus, theme: RenderTheme, expanded?: boolean, commands?: string[]): string;
export declare function renderWriteStdinCall(sessionId: number | string, input: string | undefined, command: string | undefined, theme: RenderTheme): string;
