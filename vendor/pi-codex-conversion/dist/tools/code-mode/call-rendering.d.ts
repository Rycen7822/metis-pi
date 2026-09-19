import { Text } from "@earendil-works/pi-tui";
import type { CodeModeRenderTracker } from "./render-tracker.js";
import type { CodeModeRenderContext, CodeModeRenderTheme } from "./types.js";
export declare function renderExecCall(args: {
    code?: unknown;
}, theme: CodeModeRenderTheme, context: CodeModeRenderContext | undefined, tracker: CodeModeRenderTracker, richRendering?: boolean): Text;
export declare function renderWaitCall(args: {
    cell_id?: unknown;
    terminate?: unknown;
}, theme: CodeModeRenderTheme, context: CodeModeRenderContext | undefined, tracker: CodeModeRenderTracker, richRendering?: boolean): Text;
