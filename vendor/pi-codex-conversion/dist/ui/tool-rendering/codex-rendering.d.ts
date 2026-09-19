import { type ShellAction } from "../../shell/summary.ts";
import type { ExecCommandStatus } from "../../tools/exec/command-state.ts";
export interface RenderTheme {
    fg(role: string, text: string): string;
    bold(text: string): string;
}
export declare function renderExecCommandCall(command: string, state: ExecCommandStatus, theme: RenderTheme, expanded?: boolean): string;
export declare function renderGroupedExecCommandCall(actionGroups: ShellAction[][], state: ExecCommandStatus, theme: RenderTheme, expanded?: boolean, commands?: string[]): string;
export declare function renderWriteStdinCall(sessionId: number | string, input: string | undefined, command: string | undefined, theme: RenderTheme): string;
