import { type Component } from "@earendil-works/pi-tui";
import { CodeModeNestedRenderStore } from "./trace-render-state.js";
import type { CodeModeRenderContext, CodeModeRenderTheme, CodeModeToolDefinition, RuntimeToolTrace } from "./types.js";
export { CodeModeNestedRenderStore } from "./trace-render-state.js";
export declare function renderTraceAndOutput(traces: RuntimeToolTrace[], droppedTraceCount: number, tools: CodeModeToolDefinition[], output: Component, hasOutput: boolean, options: {
    expanded: boolean;
    isPartial: boolean;
}, theme: CodeModeRenderTheme, context: CodeModeRenderContext | undefined, emittedImages: Map<string, Set<string>>, renderStore: CodeModeNestedRenderStore): Component;
