import { type Component } from "@earendil-works/pi-tui";
import { type RenderedToolContent } from "./render-content.js";
import type { CodeModeRenderTracker } from "./render-tracker.js";
import { type CodeModeNestedRenderStore } from "./trace-rendering.js";
import type { CodeModeRenderContext, CodeModeRenderTheme, CodeModeToolDefinition } from "./types.js";
export declare function renderTrackedCodeModeResult(result: {
    content: RenderedToolContent[];
    details?: unknown;
}, options: {
    expanded: boolean;
    isPartial: boolean;
}, theme: CodeModeRenderTheme, context: CodeModeRenderContext | undefined, tracker: CodeModeRenderTracker, renderStore: CodeModeNestedRenderStore, tools?: CodeModeToolDefinition[], richRendering?: boolean, minimalOutput?: boolean): Component;
