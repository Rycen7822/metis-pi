import type { CodeModeToolDefinition } from "./types.js";
export declare const EXEC_DESCRIPTION = "Run JavaScript to compose tools; source only, no JSON or fences\nRuntime follows the selected mode: Code is fresh restricted JS with no console/imports/Node/browser APIs; Notebook is one persistent Deno TypeScript global environment shared by every exec call, with console, imports, npm, Deno, and Web APIs\nOptional // @exec: {\"yield_time_ms\": 10000, \"max_output_tokens\": 1000}; defaults 30000 ms/10000 tokens\nAwait work; bare values are discarded; globals: tools, image, generatedImage, store, load, exit, setTimeout, clearTimeout, ALL_TOOLS; text(value) serializes output, notify(value) emits, yield_control() yields";
export declare const WAIT_DESCRIPTION = "Resume or terminate a yielded exec cell";
export declare function formatCodeModeToolHelp(tool: CodeModeToolDefinition): string;
export declare function buildCodeModeToolsPrompt(tools: CodeModeToolDefinition[], documentationPath?: string, existingPrompt?: string): string;
export declare function injectCodeModeToolsPrompt(systemPrompt: string, tools: CodeModeToolDefinition[], documentationPath?: string): string;
export declare function replaceCodeModeToolsPrompt(systemPrompt: string, previousSection: string | undefined, nextTools: CodeModeToolDefinition[], documentationPath?: string): {
    systemPrompt: string;
    section: string;
};
